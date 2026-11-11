import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWeek } from "../src/backtest/model.ts";
import { mondaysIn, selectWeeks } from "../src/backtest/analysis.ts";
import { addDays, dayRange, weekday } from "../src/lib/dates.ts";

// Delivery week starting Monday 2025-03-10. The auction opens 2025-03-03 00:00;
// the latest final print is 2025-03-02, and the oldest allowed is 2025-02-28.
const WEEK = "2025-03-10";

function series(entries: Array<[string, number]>): Map<string, number> {
  return new Map(entries);
}
const fullDelivery = (v: number): Array<[string, number]> => dayRange(WEEK, addDays(WEEK, 6)).map((d) => [d, v]);

test("anchor is the last print before the opening, never one from the opening day or later", () => {
  const s = series([["2025-03-01", 1_000_000], ["2025-03-02", 2_000_000], ["2025-03-03", 9_000_000], ...fullDelivery(2_000_000)]);
  const v = evaluateWeek(s, WEEK);
  assert.ok(v.ok);
  assert.equal(v.core.anchorDay, "2025-03-02");
  assert.equal(v.core.anchor, 2_000_000);
});

test("anchor falls back up to 3 days, then the week is dropped as stale", () => {
  const ok = evaluateWeek(series([["2025-02-28", 1_500_000], ...fullDelivery(2_000_000)]), WEEK);
  assert.ok(ok.ok);
  assert.equal(ok.core.anchorDay, "2025-02-28");
  const stale = evaluateWeek(series([["2025-02-27", 1_500_000], ...fullDelivery(2_000_000)]), WEEK);
  assert.deepEqual(stale, { ok: false, week: WEEK, reason: "stale_anchor" });
});

test("a week needs 4 daily prints; 3 drops it", () => {
  const anchor: [string, number] = ["2025-03-02", 2_000_000];
  const four = evaluateWeek(series([anchor, ...fullDelivery(2_000_000).slice(0, 4)]), WEEK);
  assert.ok(four.ok);
  assert.equal(four.core.prints, 4);
  const three = evaluateWeek(series([anchor, ...fullDelivery(2_000_000).slice(0, 3)]), WEEK);
  assert.deepEqual(three, { ok: false, week: WEEK, reason: "few_prints" });
});

test("fixing is the mean of the prints present, rounded down; the next Monday is not in the week", () => {
  const s = series([
    ["2025-03-02", 2_000_000],
    ["2025-03-10", 2_000_000],
    ["2025-03-11", 2_000_001],
    ["2025-03-13", 2_000_001],
    ["2025-03-16", 2_000_001],
    ["2025-03-17", 9_000_000],
  ]);
  const v = evaluateWeek(s, WEEK);
  assert.ok(v.ok);
  assert.equal(v.core.prints, 4);
  assert.equal(v.core.fixing, 2_000_000); // floor(8_000_003 / 4)
});

test("candidate weeks are Mondays fully inside the window", () => {
  const days = dayRange("2024-11-01", "2024-12-31");
  const ms = mondaysIn(days);
  assert.equal(ms[0], "2024-11-04");
  assert.ok(ms.every((d) => weekday(d) === 0));
  assert.equal(ms[ms.length - 1], "2024-12-23"); // 2024-12-30 would end after the window
});

test("week selection reports every dropped week with its reason", () => {
  const days = dayRange("2025-01-01", "2025-03-31");
  const index = new Map<string, number>();
  for (const d of days) if (d < "2025-02-01" || d > "2025-02-20") index.set(d, 2_000_000);
  const { kept, excluded, mondays } = selectWeeks({ days, index, providers: new Map(), outOfComposite: new Set() });
  assert.equal(kept.length + excluded.length, mondays.length);
  assert.ok(excluded.some((e) => e.reason === "few_prints"));
  assert.ok(excluded.some((e) => e.reason === "stale_anchor"));
  for (const c of kept) assert.equal(c.fixing, 2_000_000);
});
