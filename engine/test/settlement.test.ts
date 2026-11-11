import assert from "node:assert/strict";
import { test } from "node:test";
import { bonus, payouts, redeemAmount, settleSeries, type SettlementInput } from "../src/mod.ts";

const base: SettlementInput = {
  floor: 2_000_000,
  band: 400_000,
  sum: 6_600_002n,
  count: 3,
  openSets: 10,
  pool: 0n,
  voidAllowed: false,
  minPrints: 3,
};

test("normal settlement uses the mean rounded down", () => {
  // 6_600_002 / 3 = 2_200_000.67
  assert.deepEqual(settleSeries(base), {
    fixing: 2_200_000,
    void: false,
    longPayout: 200_000,
    shortPayout: 200_000,
    bonusLong: 0n,
    bonusShort: 0n,
    carry: 0n,
  });
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
  const out = settleSeries({ ...base, count: 2, sum: 4_300_001n, voidAllowed: true });
  assert.equal(out.void, true);
  assert.equal(out.fixing, 2_150_000);
  assert.equal(out.longPayout, 150_000);
  assert.equal(out.shortPayout, 250_000);
});

test("void settlement with no prints fixes at the middle of the band", () => {
  const out = settleSeries({ ...base, count: 0, sum: 0n, voidAllowed: true });
  assert.equal(out.void, true);
  assert.equal(out.fixing, 2_200_000);
  assert.deepEqual(payouts(out.fixing, base.floor, base.band), { longPayout: 200_000, shortPayout: 200_000 });
});

test("bonus splits per set, short takes the odd unit, the rest carries", () => {
  assert.deepEqual(bonus(1001n, 10), { bonusLong: 50n, bonusShort: 50n, carry: 1n });
  assert.deepEqual(bonus(1039n, 10), { bonusLong: 51n, bonusShort: 52n, carry: 9n });
  assert.deepEqual(bonus(9n, 10), { bonusLong: 0n, bonusShort: 0n, carry: 9n });
  assert.deepEqual(bonus(1n, 1), { bonusLong: 0n, bonusShort: 1n, carry: 0n });
  assert.deepEqual(bonus(777n, 0), { bonusLong: 0n, bonusShort: 0n, carry: 777n });
  assert.deepEqual(bonus(0n, 0), { bonusLong: 0n, bonusShort: 0n, carry: 0n });
});

test("everything paid out plus the carry equals backing plus pool", () => {
  const out = settleSeries({ ...base, pool: 1039n });
  const paid = redeemAmount({ long: 10, short: 10 }, out);
  // 10 * (200_000 + 51) + 10 * (200_000 + 52) = 4_001_030
  assert.equal(paid, 4_001_030n);
  assert.equal(paid + out.carry, 10n * 400_000n + 1039n);
});

test("redeem amount of a one-sided position", () => {
  const s = { longPayout: 300, shortPayout: 100, bonusLong: 2n, bonusShort: 3n };
  assert.equal(redeemAmount({ long: 7, short: 0 }, s), 2114n);
  assert.equal(redeemAmount({ long: 0, short: 7 }, s), 721n);
});
