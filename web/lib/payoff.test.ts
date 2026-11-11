import assert from "node:assert/strict";
import { test } from "node:test";
import { clampFixing, fixingFromX, hedgeSize, longPayout, parseGpuHours, payoffAt, payoffDomain, payoffGeometry, stepFixing } from "./payoff.ts";

const floor = 2_000_000;
const band = 800_000;
const p = 300_000;

test("inside the band both sides fix floor + p", () => {
  for (const f of [floor, floor + 1, floor + band / 2, floor + band]) {
    assert.equal(payoffAt("Long", f, floor, band, p).hedged, floor + p);
    assert.equal(payoffAt("Short", f, floor, band, p).hedged, floor + p);
  }
});

test("at the band edges the payout is 0 and band; outside, the hedge stops", () => {
  assert.equal(longPayout(floor, floor, band), 0);
  assert.equal(longPayout(floor + band, floor, band), band);
  assert.equal(longPayout(floor - 1, floor, band), 0);
  assert.equal(longPayout(floor + band + 1, floor, band), band);
  // Below the floor a buyer pays the fixing plus the premium; above the cap the payout is capped.
  assert.equal(payoffAt("Long", floor - 100_000, floor, band, p).hedged, floor - 100_000 + p);
  assert.equal(payoffAt("Long", floor + band + 100_000, floor, band, p).hedged, floor + band + 100_000 - band + p);
  // A seller's SHORT pays band - LONG payout.
  assert.equal(payoffAt("Short", floor - 1, floor, band, p).payout, band);
  assert.equal(payoffAt("Short", floor + band, floor, band, p).payout, 0);
});

test("the geometry draws the hedged line flat between the kinks", () => {
  const g = payoffGeometry({ side: "Long", floor, band, p, fixing: floor + 100_000, width: 600, height: 300 });
  assert.equal(g.kinks.length, 2);
  assert.equal(g.kinks[0]!.y, g.kinks[1]!.y);
  assert.equal(g.band.x1, g.kinks[0]!.x);
  assert.equal(g.band.x2, g.kinks[1]!.x);
  assert.equal(g.domain.lo, floor - band / 2);
  assert.equal(g.domain.hi, floor + 1.5 * band);
  assert.ok(g.hedged.split(" ").length === 4);
  assert.ok(g.handle.x > g.band.x1 && g.handle.x < g.band.x2);
});

test("the handle steps one tick, ten with shift, and stays in the domain", () => {
  assert.equal(stepFixing(floor, 1, false, 10_000, floor, band), floor + 10_000);
  assert.equal(stepFixing(floor, -1, true, 10_000, floor, band), floor - 100_000);
  const d = payoffDomain(floor, band);
  assert.equal(stepFixing(d.hi, 1, true, 10_000, floor, band), d.hi);
  assert.equal(clampFixing(-5, floor, band), d.lo);
  const g = payoffGeometry({ side: "Short", floor, band, p, fixing: floor, width: 600, height: 300 });
  assert.equal(fixingFromX(g.plot.x0 - 50, g, 10_000), d.lo);
  assert.equal(fixingFromX(g.band.x1, g, 10_000), floor);
});

test("a floor under half the band keeps the domain at zero or above", () => {
  assert.equal(payoffDomain(100_000, 400_000).lo, 0);
});

test("the sizer: units, lock, worst case", () => {
  const h = hedgeSize(1344, "Long", floor, band, p)!;
  assert.equal(h.units, 1344);
  assert.equal(h.locked, 1344n * 300_000n);
  assert.equal(h.maxLoss, h.locked);
  assert.equal(h.effective, floor + p);
  const s = hedgeSize(1344, "Short", floor, band, p)!;
  assert.equal(s.locked, 1344n * 500_000n);
  assert.equal(hedgeSize(0, "Long", floor, band, p), null);
  assert.equal(hedgeSize(10, "Long", floor, band, 0), null);
  assert.equal(hedgeSize(10, "Long", floor, band, band), null);
});

test("GPU-hours input accepts commas and refuses the rest", () => {
  assert.equal(parseGpuHours("1,344", 1_000_000), 1344);
  assert.equal(parseGpuHours("0", 100), null);
  assert.equal(parseGpuHours("12.5", 100), null);
  assert.equal(parseGpuHours("", 100), null);
  assert.equal(parseGpuHours("101", 100), null);
});
