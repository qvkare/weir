import assert from "node:assert/strict";
import { test } from "node:test";
import { commitHash, commitPreimage, computeBand, isFar, median, printDecision } from "../src/mod.ts";

// Band, section 6.1

test("band of a typical anchor", () => {
  // mid = 2_345_000; anchor * 10% = 234_567.8 -> 234_567 -> 234_000.
  assert.deepEqual(computeBand(2_345_678, 1000, 1000), { mid: 2_345_000, half: 234_000, floor: 2_111_000, band: 468_000 });
});

test("band exactly one tick wide on each side", () => {
  assert.deepEqual(computeBand(10_000, 1000, 1000), { mid: 10_000, half: 1000, floor: 9000, band: 2000 });
});

test("band of an anchor already on the tick, with a large product", () => {
  // 9e15 * 5000 passes 2^53, which is why the product is a bigint.
  assert.deepEqual(computeBand(9e15, 1, 5000), { mid: 9e15, half: 4.5e15, floor: 4.5e15, band: 9e15 });
});

test("band panics when half is below one tick", () => {
  // 5000 * 10% = 500, which rounds down to 0 ticks.
  assert.throws(() => computeBand(5000, 1000, 1000), /narrower than one tick/);
  assert.throws(() => computeBand(9_999, 1000, 1000), /narrower than one tick/);
});

test("band panics when half is above mid", () => {
  // Unreachable with 0 < band_bps < 10000; reachable for the function on its own.
  // mid = 1000; 1500 * 200% = 3000 > 1000.
  assert.throws(() => computeBand(1500, 1000, 20_000), /wider than the anchor/);
});

// Commit hash, section 6.2. Expected digests come from `printf ... | shasum -a 256`.

test("commit preimage and hash", () => {
  const long = { series: 0, round: 0, accountId: "a", side: "Long", size: 1, price: 1000, salt: "0".repeat(32) } as const;
  assert.equal(commitPreimage(long), "weir:v1|0|0|a|L|1|1000|00000000000000000000000000000000");
  assert.equal(commitHash(long), "73585393f2bbb4801878d1523f25abc38d2746a6bfb648dedab494a78c8d8e0b");
  const short = {
    series: 12,
    round: 3,
    accountId: "alice.near",
    side: "Short",
    size: 250,
    price: 1_475_000,
    salt: "0123456789abcdef".repeat(4),
  } as const;
  assert.equal(commitPreimage(short), `weir:v1|12|3|alice.near|S|250|1475000|${"0123456789abcdef".repeat(4)}`);
  assert.equal(commitHash(short), "0e21ea44857ee5c18cb57982978018279018415aedf302e692555625e877cfbd");
});

// Index, section 9

test("median", () => {
  assert.equal(median([5]), 5);
  assert.equal(median([2, 1]), 1);
  assert.equal(median([1, 4]), 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2);
  assert.equal(median([10, 10, 30, 30]), 20);
  assert.equal(median([2 ** 52, 2 ** 52 + 1]), 2 ** 52);
  assert.throws(() => median([]));
});

test("far is strict at the max move", () => {
  // 5% of 1_000_000 is 50_000.
  assert.equal(isFar(1_050_000, 1_000_000, 500), false);
  assert.equal(isFar(950_000, 1_000_000, 500), false);
  assert.equal(isFar(1_050_001, 1_000_000, 500), true);
  assert.equal(isFar(949_999, 1_000_000, 500), true);
});

test("a print needs quorum, or every reporter when it is far", () => {
  const base = { last: 1_000_000, quorum: 2, reporters: 3, maxMoveBps: 500 };
  assert.deepEqual(printDecision({ ...base, reports: [1_010_000] }), { final: false, price: null });
  assert.deepEqual(printDecision({ ...base, reports: [1_010_000, 1_020_000] }), { final: true, price: 1_015_000 });
  // A 10% move with quorum but not every reporter waits.
  assert.deepEqual(printDecision({ ...base, reports: [1_100_000, 1_100_000] }), { final: false, price: null });
  assert.deepEqual(printDecision({ ...base, reports: [1_100_000, 1_100_000, 1_200_000] }), { final: true, price: 1_100_000 });
  // With no comparable last print nothing is far.
  assert.deepEqual(printDecision({ ...base, last: null, reports: [5_000_000, 5_000_001] }), { final: true, price: 5_000_000 });
  // One reporter of one is every reporter, far or not.
  assert.deepEqual(printDecision({ ...base, quorum: 1, reporters: 1, reports: [9_000_000] }), { final: true, price: 9_000_000 });
  // The median, not the outlier, is what is tested for far.
  assert.deepEqual(printDecision({ ...base, reports: [1_000_000, 9_000_000] }), { final: false, price: null });
  assert.deepEqual(printDecision({ ...base, reports: [1_000_000, 1_001_000, 9_000_000] }), { final: true, price: 1_001_000 });
});
