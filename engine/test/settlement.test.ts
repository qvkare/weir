import assert from "node:assert/strict";
import { test } from "node:test";
import { fixingOf, payouts, redeemAmount, settleSeries, type SettlementInput } from "../src/mod.ts";

const base: SettlementInput = {
  floor: 2_000_000,
  band: 400_000,
  sum: 6_600_002n,
  count: 3,
  tradedUnits: 0,
  tradedValue: 0n,
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

test("a void series unwinds at the average traded price, ignoring a partial set of prints", () => {
  // 10 units at 200_000 and 5 at 300_000: 3_500_000 / 15 = 233_333.33.
  const traded = { tradedUnits: 15, tradedValue: 3_500_000n };
  for (const prints of [{ count: 0, sum: 0n }, { count: 2, sum: 4_300_001n }]) {
    assert.deepEqual(settleSeries({ ...base, ...prints, ...traded, voidAllowed: true }), {
      fixing: 2_233_333,
      void: true,
      longPayout: 233_333,
      shortPayout: 166_667,
    });
  }
  // Traded data does not touch a normal settlement.
  assert.equal(settleSeries({ ...base, ...traded }).fixing, 2_200_000);
});

test("a void series that never traded splits the band evenly", () => {
  assert.deepEqual(settleSeries({ ...base, count: 2, sum: 4_300_001n, voidAllowed: true }), {
    fixing: 2_200_000,
    void: true,
    longPayout: 200_000,
    shortPayout: 200_000,
  });
  assert.deepEqual(fixingOf({ ...base, count: 0, sum: 0n, voidAllowed: true, band: 400_001 }), { fixing: 2_200_000, void: true });
});

test("redeem pays the payouts and nothing more", () => {
  const p = { longPayout: 300, shortPayout: 100 };
  assert.equal(redeemAmount({ long: 7, short: 0 }, p), 2100n);
  assert.equal(redeemAmount({ long: 0, short: 7 }, p), 700n);
  // Every set pays exactly the band.
  assert.equal(redeemAmount({ long: 10, short: 10 }, p), 4000n);
});
