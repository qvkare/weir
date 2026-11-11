import assert from "node:assert/strict";
import { test } from "node:test";
import { clearRound, curves } from "@weir/engine";
import { buildFloor, checkFloor, floorBeat, FLOOR_EXAMPLE, FLOOR_TICK, scanRow } from "./floor.ts";
import { layoutDots } from "./dotmatrix.ts";

const plan = buildFloor();

test("the floor is the engine's clearing of the example book", () => {
  const c = clearRound(FLOOR_EXAMPLE, FLOOR_TICK);
  assert.equal(plan.clearing.price, c.price);
  assert.equal(plan.clearing.volume, c.volume);
  plan.tickets.forEach((t, i) => assert.equal(t.filled, c.fills[i]));
  // The example shows every outcome: full, part and returned.
  assert.deepEqual(new Set(plan.tickets.map((t) => t.state)), new Set(["full", "part", "out"]));
});

test("the rack's rows are the book's prices, highest first, with the engine's curves", () => {
  const pts = curves(FLOOR_EXAMPLE);
  assert.deepEqual(plan.rows.map((r) => r.price), pts.map((p) => p.price).reverse());
  for (const r of plan.rows) {
    const p = pts.find((x) => x.price === r.price)!;
    assert.equal(r.demand, p.demand);
    assert.equal(r.supply, p.supply);
  }
  assert.equal(plan.rows[plan.clearRow]!.price, plan.clearing.price);
  for (const t of plan.tickets) assert.equal(plan.rows[t.row]!.price, t.price);
});

test("buyers line up highest first and sellers lowest first", () => {
  const side = (s: string) => plan.tickets.filter((t) => t.side === s).sort((a, b) => a.rank - b.rank);
  const L = side("Long").map((t) => t.price);
  const S = side("Short").map((t) => t.price);
  assert.deepEqual(L, [...L].sort((a, b) => b - a));
  assert.deepEqual(S, [...S].sort((a, b) => a - b));
  // The arrival order is a permutation of the ranks.
  for (const s of ["Long", "Short"]) assert.deepEqual(side(s).map((t) => t.arrival).sort(), side(s).map((t) => t.rank).sort());
});

test("the timeline is sound: every move in order and inside the score", () => {
  assert.deepEqual(checkFloor(plan), []);
  assert.equal(plan.beats[0]!.at, 0);
  assert.ok(plan.T.scan < plan.T.lit && plan.T.lit < plan.T.hold && plan.T.hold < plan.total);
  assert.equal(floorBeat(plan, 0), 0);
  assert.equal(floorBeat(plan, plan.total), plan.beats.length - 1);
});

test("the scanner starts above the rack and settles on the clearing row", () => {
  assert.ok(scanRow(plan, 0) < 0);
  assert.ok(Math.abs(scanRow(plan, plan.T.lit) - plan.clearRow) < 0.5);
  assert.ok(Math.abs(scanRow(plan, plan.total) - plan.clearRow) < 0.01);
});

test("captions carry the engine's figures and name tickets by side and price", () => {
  const last = plan.beats[plan.beats.length - 1]!.label;
  assert.match(last, /\$2\.\d\d \/GPU-h/);
  assert.ok(!/lab-|dc-|spare-|agent-/.test(last), last);
  assert.match(plan.summary, /^Example round of 10 sealed bids, cleared by the Weir engine/);
});

test("the dot-matrix face lays text on the 5 by 7 grid", () => {
  assert.equal(layoutDots("8").width, 5);
  assert.equal(layoutDots("1.").width, 7);
  assert.equal(layoutDots("H100").dots.length, 17 + 10 + 19 + 19);
  for (const [, r] of layoutDots("$2.76 /GPU-h").dots) assert.ok(r >= 0 && r < 9);
});
