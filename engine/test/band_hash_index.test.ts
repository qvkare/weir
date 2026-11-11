import assert from "node:assert/strict";
import { test } from "node:test";
import { commitHash, commitPreimage, computeBand, decidePrint, median, printDecision } from "../src/mod.ts";

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
  assert.throws(() => computeBand(5000, 1000, 1000), { message: "band is narrower than one tick" });
  assert.throws(() => computeBand(9_999, 1000, 1000), { message: "band is narrower than one tick" });
});

test("band panics when half is above mid", () => {
  // Unreachable with 0 < band_bps < 10000; reachable for the function on its own.
  // mid = 1000; 1500 * 200% = 3000 > 1000.
  assert.throws(() => computeBand(1500, 1000, 20_000), { message: "band is wider than the price" });
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

test("deciding a bucket: quorum, middle report, spread of the two middle", () => {
  // Fewer than quorum: no print.
  assert.equal(decidePrint([], 1, 500), null);
  assert.equal(decidePrint([2_000_000], 2, 500), null);
  // Odd count: the middle report, however far the others are.
  assert.equal(decidePrint([1, 2_000_000, 9_000_000], 2, 500), 2_000_000);
  assert.equal(decidePrint([2_000_000], 1, 500), 2_000_000);
  // Even count: 5% of 2_000_000 is 100_000; exactly that spread still prints.
  assert.equal(decidePrint([2_100_000, 2_000_000], 2, 500), 2_050_000);
  assert.equal(decidePrint([2_000_000, 2_100_001], 2, 500), null);
  assert.equal(decidePrint([2_000_000, 2_000_001], 2, 500), 2_000_000);
  // Four reports: only the two middle matter.
  assert.equal(decidePrint([1, 2_000_000, 2_000_003, 9_000_000], 2, 1), 2_000_001);
  assert.equal(decidePrint([1, 2_000_000, 2_000_201, 9_000_000], 2, 1), null);
  // The spread product passes 2^53 for large prices.
  assert.equal(decidePrint([2 ** 50, 2 ** 50 + 2], 2, 1), 2 ** 50 + 1);
});

test("a bucket is open until every reporter reports or its window closes", () => {
  const base = { quorum: 2, reporters: 3, maxSpreadBps: 500 };
  assert.deepEqual(printDecision({ ...base, reports: [2_000_000], windowClosed: false }), { state: "Open", price: null });
  assert.deepEqual(printDecision({ ...base, reports: [2_000_000, 2_000_000], windowClosed: false }), {
    state: "Open",
    price: null,
  });
  assert.deepEqual(printDecision({ ...base, reports: [2_000_000, 2_000_002], windowClosed: true }), {
    state: "Final",
    price: 2_000_001,
  });
  assert.deepEqual(printDecision({ ...base, reports: [2_000_000], windowClosed: true }), { state: "NoPrint", price: null });
  assert.deepEqual(printDecision({ ...base, reports: [1, 5, 9_000_000], windowClosed: false }), { state: "Final", price: 5 });
  assert.deepEqual(printDecision({ ...base, reports: [1_000_000, 2_000_000], windowClosed: true }), {
    state: "NoPrint",
    price: null,
  });
});
