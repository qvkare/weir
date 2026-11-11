import assert from "node:assert/strict";
import { test } from "node:test";
import { indexChartGeometry, type IndexPrint } from "./index-chart.ts";
import { seriesStage, timelineGeometry, type SeriesTimes } from "./timeline.ts";

const s: SeriesTimes = { series: 3, auctionOpen: 0, auctionClose: 4200, deliveryStart: 4800, deliveryEnd: 8400, settleAt: 8460, commitSecs: 180, revealSecs: 120 };

test("the strip has one block per round, commit before reveal", () => {
  const g = timelineGeometry(s, 1000, 1000, 3);
  assert.equal(g.blocks.length, 14);
  assert.ok(g.blocks.every((b) => b.a < b.mid && b.mid < b.b));
  assert.equal(g.blocks.filter((b) => b.current).length, 1);
  assert.ok(g.delivery.a < g.delivery.b);
  assert.ok(g.now.inside);
  assert.equal(g.dense, false);
  assert.deepEqual(g.marks.map((m) => m.kind), ["open", "cutoff", "delivery", "end", "settle"]);
});

test("a long auction draws dense blocks and the now rule stays on the axis", () => {
  const week = { ...s, auctionOpen: 0, auctionClose: 608_400, deliveryStart: 612_000, deliveryEnd: 1_216_800, settleAt: 1_217_700, commitSecs: 2700, revealSecs: 900 };
  const g = timelineGeometry(week, 5_000_000, 400, null);
  assert.equal(g.blocks.length, 169);
  assert.equal(g.dense, true);
  assert.equal(g.now.pos, 400);
  assert.equal(g.now.inside, false);
});

test("stages in words", () => {
  assert.equal(seriesStage(s, -1), "Auctions not open yet");
  assert.equal(seriesStage(s, 10), "In auction");
  assert.equal(seriesStage(s, 4500), "Auctions closed");
  assert.equal(seriesStage(s, 5000), "In delivery");
  assert.equal(seriesStage(s, 8430), "Delivery over, report window open");
  assert.equal(seriesStage(s, 9000), "Ready to settle");
});

const prints = (buckets: number[]): IndexPrint[] => buckets.map((b, i) => ({ bucket: b, price: 2_000_000 + i * 10_000, reports: [{ reporter: "r1", price: 1_990_000 + i * 10_000 }, { reporter: "r2", price: 2_010_000 + i * 10_000 }] }));

test("the index is a step line; a missing print is a gap, never interpolated", () => {
  const g = indexChartGeometry({ prints: prints([0, 100, 200, 400, 500]), interval: 100, from: 0, to: 600, band: null, width: 800, height: 300 });
  assert.equal(g.gaps, 1);
  assert.equal((g.index.match(/M/g) ?? []).length, 2);
  assert.ok(!g.index.includes("NaN"));
  assert.equal(g.reporters.length, 2);
  assert.ok(g.last && g.last.price === 2_040_000);
});

test("no prints: an empty chart with finite ticks", () => {
  const g = indexChartGeometry({ prints: [], interval: 100, from: 0, to: 600, band: null, width: 375, height: 240 });
  assert.equal(g.index, "");
  assert.equal(g.last, null);
  assert.ok(g.yTicks.length > 0 && g.yTicks.every((t) => Number.isFinite(t.y)));
});

test("the band covers the delivery window and holds the running average", () => {
  const g = indexChartGeometry({ prints: prints([0, 100, 200]), interval: 100, from: 0, to: 600, band: { floor: 1_800_000, band: 400_000, start: 100, end: 10_000, average: 2_010_000 }, width: 800, height: 300 });
  assert.ok(g.band);
  assert.equal(g.band.x + g.band.w, g.plot.x1);
  assert.ok(g.band.avgY! > g.band.y && g.band.avgY! < g.band.y + g.band.h);
});
