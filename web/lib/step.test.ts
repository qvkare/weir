import assert from "node:assert/strict";
import { test } from "node:test";
import { clearRound } from "@weir/engine";
import { curveLabels, sizesAt, stepGeometry, type StepOrder } from "./step.ts";

const band = 1_000_000;
const base = { band, width: 1000, height: 400 };
const orders: StepOrder[] = [
  { seq: 0, owner: "a", side: "Long", size: 10, price: 600_000 },
  { seq: 1, owner: "b", side: "Long", size: 10, price: 400_000 },
  { seq: 2, owner: "c", side: "Short", size: 15, price: 300_000 },
  { seq: 3, owner: "d", side: "Short", size: 10, price: 700_000 },
];

test("demand falls from the highest LONG, supply rises from the lowest SHORT", () => {
  const g = stepGeometry({ ...base, orders, price: null, volume: 0, cleared: false });
  const longs = g.steps.filter((s) => s.side === "Long");
  assert.deepEqual(longs.map((s) => s.seq), [0, 1]);
  assert.ok(longs[0]!.y < longs[1]!.y, "higher price is higher on screen");
  const shorts = g.steps.filter((s) => s.side === "Short");
  assert.deepEqual(shorts.map((s) => s.seq), [2, 3]);
  assert.ok(shorts[0]!.y > shorts[1]!.y);
  assert.equal(g.xMax, 25);
  // Demand ends on the zero line, supply on the band.
  assert.equal(g.demand.at(-1)!.y2, g.plot.y1);
  assert.equal(g.supply.at(-1)!.y2, g.plot.y0);
  assert.equal(g.noClearing, "not cleared");
});

test("the clearing marker sits at p* and V*, and the part-filled step splits at V*", () => {
  const c = clearRound(orders, 10_000);
  assert.equal(c.volume, 15);
  const filled = orders.map((o, i) => ({ ...o, filled: c.fills[i]! }));
  const g = stepGeometry({ ...base, orders: filled, price: c.price, volume: c.volume, cleared: true });
  assert.ok(g.clearing);
  const X = (u: number) => g.plot.x0 + (u / g.xMax) * (g.plot.x1 - g.plot.x0);
  const Y = (p: number) => g.plot.y1 - (p / band) * (g.plot.y1 - g.plot.y0);
  assert.equal(g.clearing.x, X(15));
  assert.equal(g.clearing.y, Y(c.price!));
  const partial = g.steps.find((s) => s.seq === 1)!;
  assert.equal(partial.partAt, X(15));
  assert.equal(partial.filled, 5);
  // Filled LONGs paid the rectangle under p*; SHORTs the one above it, to the band.
  assert.equal(g.clearing.longRect.h + g.clearing.shortRect.h, g.plot.y1 - g.plot.y0);
  assert.equal(g.clearing.longRect.w, X(15) - g.plot.x0);
  // Thick segments stay left of V*.
  for (const s of [...g.demand, ...g.supply].filter((s) => s.filled && s.y1 === s.y2)) assert.ok(Math.max(s.x1, s.x2) <= X(15) + 1e-9);
});

test("no orders: an empty chart that says so", () => {
  const g = stepGeometry({ ...base, orders: [], price: null, volume: 0, cleared: true });
  assert.equal(g.noClearing, "no orders");
  assert.equal(g.demand.length, 0);
  assert.equal(g.supply.length, 0);
  assert.equal(g.xMax, 1);
  assert.ok(g.yTicks.every((t) => Number.isFinite(t.y)));
});

test("one side only: one curve and no clearing", () => {
  const g = stepGeometry({ ...base, orders: orders.filter((o) => o.side === "Long"), price: null, volume: 0, cleared: true });
  assert.equal(g.noClearing, "one side only");
  assert.ok(g.demand.length > 0);
  assert.equal(g.supply.length, 0);
});

test("no clearing price when the curves do not cross", () => {
  const apart: StepOrder[] = [
    { seq: 0, owner: "a", side: "Long", size: 5, price: 200_000 },
    { seq: 1, owner: "b", side: "Short", size: 5, price: 800_000 },
  ];
  const c = clearRound(apart, 10_000);
  assert.equal(c.price, null);
  const g = stepGeometry({ ...base, orders: apart, price: c.price, volume: c.volume, cleared: true });
  assert.equal(g.clearing, null);
  assert.equal(g.noClearing, "no cross");
  assert.ok([...g.demand, ...g.supply].every((s) => !s.filled));
});

test("a zero band does not divide by zero", () => {
  const g = stepGeometry({ ...base, band: 0, orders, price: null, volume: 0, cleared: false });
  for (const s of [...g.demand, ...g.supply]) assert.ok([s.x1, s.x2, s.y1, s.y2].every(Number.isFinite));
});

test("sizes at a price follow SPEC 7.1", () => {
  assert.deepEqual(sizesAt(orders, 400_000), { demand: 20, supply: 15 });
  assert.deepEqual(sizesAt(orders, 700_000), { demand: 0, supply: 25 });
});

test("curve labels never overlap, even when both curves start at the same price", () => {
  for (const p of [500_000, 100_000, 10_000, 990_000]) {
    for (const width of [375, 1200]) {
      const same: StepOrder[] = [
        { seq: 0, owner: "a", side: "Long", size: 10, price: p },
        { seq: 1, owner: "b", side: "Short", size: 10, price: p },
      ];
      const g = stepGeometry({ ...base, width, orders: same, price: null, volume: 0, cleared: false });
      const l = curveLabels(g);
      assert.ok(l.demand && l.supply);
      assert.ok(Math.abs(l.demand.y - l.supply.y) >= 16, `price ${p} width ${width}: ${l.demand.y} vs ${l.supply.y}`);
      for (const y of [l.demand.y, l.supply.y]) assert.ok(y >= g.plot.y0 + 12 - 1e-9 && y <= g.plot.y1 - 6 + 1e-9);
    }
  }
});

test("curve labels: supply just above demand stays clear of it", () => {
  const apart: StepOrder[] = [
    { seq: 0, owner: "a", side: "Long", size: 5, price: 400_000 },
    { seq: 1, owner: "b", side: "Short", size: 5, price: 410_000 },
  ];
  const g = stepGeometry({ ...base, orders: apart, price: null, volume: 0, cleared: false });
  const l = curveLabels(g);
  assert.ok(Math.abs(l.demand!.y - l.supply!.y) >= 16);
  assert.equal(curveLabels(stepGeometry({ ...base, orders: [], price: null, volume: 0, cleared: true })).demand, null);
});
