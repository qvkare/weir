import assert from "node:assert/strict";
import { test } from "node:test";
import { payouts, redeemAmount, settleSeries, type SettlementInput } from "../src/mod.ts";

const base: SettlementInput = {
  floor: 2_000_000,
  band: 400_000,
  sum: 6_600_002n,
  count: 3,
  voidAllowed: false,
  minPrints: 3,
};

test("normal settlement uses the mean rounded down", () => {
  // 6_600_002 / 3 = 2_200_000.67
  assert.deepEqual(settleSeries(base), { fixing: 2_200_000, void: false, longPayout: 200_000, shortPayout: 200_000 });
});

test("enough prints settle normally even after the void time", () => {
  assert.equal(settleSeries({ ...base, voidAllowed: true }).void, false);
});

test("payouts clamp to the band", () => {
  assert.deepEqual(payouts(1_000_000, 2_000_000, 400_000), { longPayout: 0, shortPayout: 400_000 });
  assert.deepEqual(payouts(2_000_000, 2_000_000, 400_000), { longPayout: 0, shortPayout: 400_000 });
  assert.deepEqual(payouts(2_400_000, 2_000_000, 400_000), { longPayout: 400_000, shortPayout: 0 });
  assert.deepEqual(payouts(9_000_000, 2_000_000, 400_000), { longPayout: 400_000, shortPayout: 0 });
  assert.deepEqual(payouts(2_123_456, 2_000_000, 400_000), { longPayout: 123_456, shortPayout: 276_544 });
});

test("too few prints before the void time panics", () => {
  assert.throws(() => settleSeries({ ...base, count: 2, sum: 4_000_000n }), { message: "not enough prints yet" });
  assert.throws(() => settleSeries({ ...base, count: 0, sum: 0n }), { message: "not enough prints yet" });
});

test("void settlement with some prints uses their mean", () => {
  assert.deepEqual(settleSeries({ ...base, count: 2, sum: 4_300_001n, voidAllowed: true }), {
    fixing: 2_150_000,
    void: true,
    longPayout: 150_000,
    shortPayout: 250_000,
  });
});

test("void settlement with no prints fixes at the middle of the band", () => {
  assert.deepEqual(settleSeries({ ...base, count: 0, sum: 0n, voidAllowed: true }), {
    fixing: 2_200_000,
    void: true,
    longPayout: 200_000,
    shortPayout: 200_000,
  });
});

test("redeem pays the payouts and nothing more", () => {
  const p = { longPayout: 300, shortPayout: 100 };
  assert.equal(redeemAmount({ long: 7, short: 0 }, p), 2100n);
  assert.equal(redeemAmount({ long: 0, short: 7 }, p), 700n);
  // Every set pays exactly the band.
  assert.equal(redeemAmount({ long: 10, short: 10 }, p), 4000n);
});
