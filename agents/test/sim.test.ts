// The simulation: deterministic, conserves every dollar, and trades.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentReports, createSimulation, type SimConfig } from "../src/sim.ts";

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
    return t.free + t.locked + t.setsBacking + t.pools + t.unredeemed;
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
  assert.equal(balances + t.pools, deposits, "what agents hold plus the carry pool is what they deposited");
  for (const r of agentReports(s)) assert.equal(r.result, r.received - r.paid - r.forfeited, r.id);
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
  // Two of three reporters (at -0.1% and exact) make a print: the mean of the two. The drop
  // to $1.90 moves more than max_move_bps (15%), so it needs all three: their median.
  assert.deepEqual(prints, [1_999_000, 2_098_950, 2_298_850, 1_900_000]);
});

test("the weekly preset runs: hourly rounds, a series opening on the first commit", () => {
  const s = createSimulation({ ...DEFAULT, market: "weekly" });
  const events = s.runRounds(3);
  assert.ok(events.some((e) => e.kind === "series_opened"));
  assert.equal(events.filter((e) => e.kind === "clear").length, 3);
  assert.ok(events.every((e, i) => i === 0 || e.at >= events[i - 1]!.at));
  assert.equal(s.now() % 3600, 0);
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
