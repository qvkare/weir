import assert from "node:assert/strict";
import { test } from "node:test";
import { clearRound, curves, type Order } from "../src/mod.ts";

const TICK = 1000;
const L = (seq: number, size: number, price: number): Order => ({ seq, side: "Long", size, price });
const S = (seq: number, size: number, price: number): Order => ({ seq, side: "Short", size, price });

interface Case {
  name: string;
  orders: Order[];
  price: number | null;
  volume: number;
  fills: number[];
}

// Each case is worked by hand from section 7: D, S and V at every order price, then steps 1-3.
const cases: Case[] = [
  { name: "empty round", orders: [], price: null, volume: 0, fills: [] },
  { name: "one long only", orders: [L(0, 5, 3000)], price: null, volume: 0, fills: [0] },
  { name: "one short only", orders: [S(0, 5, 3000)], price: null, volume: 0, fills: [0] },
  { name: "longs only", orders: [L(0, 5, 3000), L(1, 2, 9000)], price: null, volume: 0, fills: [0, 0] },
  { name: "shorts only", orders: [S(0, 5, 3000), S(1, 2, 1000)], price: null, volume: 0, fills: [0, 0] },
  // D(2000)=5 S(2000)=0; D(3000)=0 S(3000)=5: V is 0 everywhere.
  { name: "no cross", orders: [L(0, 5, 2000), S(1, 5, 3000)], price: null, volume: 0, fills: [0, 0] },
  { name: "no cross by one tick", orders: [L(0, 5, 1000), S(1, 5, 2000)], price: null, volume: 0, fills: [0, 0] },
  // One candidate with D = S = 5: the third branch with lo = hi.
  { name: "single cross at one price", orders: [L(0, 5, 3000), S(1, 5, 3000)], price: 3000, volume: 5, fills: [5, 5] },
  { name: "smallest cross", orders: [L(0, 1, 1000), S(1, 1, 1000)], price: 1000, volume: 1, fills: [1, 1] },
  // Candidates 2000 and 4000 both have D = S = 5: midpoint 3000.
  { name: "balanced cross takes the midpoint", orders: [L(0, 5, 4000), S(1, 5, 2000)], price: 3000, volume: 5, fills: [5, 5] },
  // Midpoint 3500 rounds down to 3000.
  { name: "midpoint rounds down to the tick", orders: [L(0, 5, 5000), S(1, 5, 2000)], price: 3000, volume: 5, fills: [5, 5] },
  { name: "wide midpoint on the tick", orders: [L(0, 4, 9000), S(1, 4, 1000)], price: 5000, volume: 4, fills: [4, 4] },
  { name: "wide midpoint rounds down", orders: [L(0, 4, 9000), S(1, 4, 2000)], price: 5000, volume: 4, fills: [4, 4] },
  // D=10 > S=5 at 2000 and 4000: excess demand, price is hi.
  { name: "excess demand takes hi", orders: [L(0, 10, 4000), S(1, 5, 2000)], price: 4000, volume: 5, fills: [5, 5] },
  // D=5 < S=10 at both: excess supply, price is lo.
  { name: "excess supply takes lo", orders: [L(0, 5, 4000), S(1, 10, 2000)], price: 2000, volume: 5, fills: [5, 5] },
  // 1000: V2; 3000 and 5000: D=10 S=4 V4 imbalance 6, both D > S: hi = 5000.
  {
    name: "excess demand over several candidates",
    orders: [L(0, 10, 5000), S(1, 2, 1000), S(2, 2, 3000)],
    price: 5000,
    volume: 4,
    fills: [4, 2, 2],
  },
  // 1000 and 3000: D=4 S=10 V4; 5000: V2. Both D < S: lo = 1000.
  {
    name: "excess supply over several candidates",
    orders: [S(0, 10, 1000), L(1, 2, 5000), L(2, 2, 3000)],
    price: 1000,
    volume: 4,
    fills: [4, 2, 2],
  },
  // 3000: D9 S3; 4000: D9 S6 (V6, imbalance 3); 5000: D6 S9 (V6, imbalance 3); 6000: D3 S9.
  // Kept 4000 (D > S) and 5000 (D < S): mixed, midpoint 4500 -> 4000.
  {
    name: "demand above at lo, supply above at hi",
    orders: [L(0, 3, 6000), L(1, 3, 5000), L(2, 3, 4000), S(3, 3, 3000), S(4, 3, 4000), S(5, 3, 5000)],
    price: 4000,
    volume: 6,
    fills: [3, 3, 0, 3, 3, 0],
  },
  // 2000: D8 S4 V4; 3000: D8 S4 V4; 4000: D5 S8 V5 imb 3; 5000: D5 S8 V5 imb 3. Both D < S: lo = 4000.
  {
    name: "largest volume wins before imbalance",
    orders: [L(0, 5, 5000), L(1, 3, 3000), S(2, 4, 2000), S(3, 4, 4000)],
    price: 4000,
    volume: 5,
    fills: [5, 0, 4, 1],
  },
  // 2000, 3000: V5 imbalance 5; 5000: D=S=5. Only 5000 is kept.
  {
    name: "smallest imbalance wins among equal volume",
    orders: [L(0, 5, 3000), L(1, 5, 5000), S(2, 5, 2000)],
    price: 5000,
    volume: 5,
    fills: [0, 5, 5],
  },
  // 2000: D=S=5; 4000, 6000: S=10. Only 2000 is kept, and the cheaper short fills.
  {
    name: "short price priority",
    orders: [S(0, 5, 4000), S(1, 5, 2000), L(2, 5, 6000)],
    price: 2000,
    volume: 5,
    fills: [0, 5, 5],
  },
  // 3000 and 6000 both D=S=5: midpoint 4500 -> 4000; the long at 2000 is below p*.
  {
    name: "long below the price is not filled",
    orders: [L(0, 5, 6000), L(1, 5, 2000), S(2, 5, 3000)],
    price: 4000,
    volume: 5,
    fills: [5, 0, 5],
  },
  // Same price, so seq decides: seq 0 (index 1) fills first and in full.
  {
    name: "partial long fill decided by seq",
    orders: [L(1, 5, 4000), L(0, 5, 4000), S(2, 6, 2000)],
    price: 4000,
    volume: 6,
    fills: [1, 5, 6],
  },
  {
    name: "partial short fill decided by seq",
    orders: [S(3, 4, 2000), S(1, 4, 2000), L(0, 5, 4000)],
    price: 2000,
    volume: 5,
    fills: [1, 4, 5],
  },
  // Higher price beats lower seq.
  {
    name: "price priority before seq",
    orders: [L(0, 4, 3000), L(5, 4, 4000), S(9, 6, 3000)],
    price: 3000,
    volume: 6,
    fills: [2, 4, 6],
  },
  // Single candidate 3000: D=4 > S=3, hi = 3000.
  {
    name: "all orders at one price, excess demand",
    orders: [L(0, 2, 3000), L(1, 2, 3000), S(2, 3, 3000)],
    price: 3000,
    volume: 3,
    fills: [2, 1, 3],
  },
  {
    name: "all orders at one price, excess supply",
    orders: [S(0, 2, 3000), L(1, 3, 3000), S(2, 2, 3000)],
    price: 3000,
    volume: 3,
    fills: [2, 3, 1],
  },
  {
    name: "interleaved equal prices",
    orders: [L(0, 3, 3000), S(1, 3, 3000), L(2, 2, 3000), S(3, 1, 3000)],
    price: 3000,
    volume: 4,
    fills: [3, 3, 1, 1],
  },
  // 4000: D6 S4 V4; 5000: D6 S7 V6. Only 5000, D < S: lo = 5000; the 5000 short fills in part.
  {
    name: "partial fill of the marginal short",
    orders: [L(0, 3, 5000), L(1, 3, 5000), S(2, 2, 4000), S(3, 2, 4000), S(4, 3, 5000)],
    price: 5000,
    volume: 6,
    fills: [3, 3, 2, 2, 2],
  },
  // 3000: D=S=2 and 7000: D=S=2. Only V matters for which longs are eligible: midpoint 5000.
  {
    name: "two balanced candidates far apart",
    orders: [L(0, 2, 7000), S(1, 2, 3000), L(2, 1, 1000)],
    price: 5000,
    volume: 2,
    fills: [2, 2, 0],
  },
  {
    name: "large sizes and prices",
    orders: [L(0, 1_000_000, 999_000), S(1, 1_000_000, 1000)],
    price: 500_000,
    volume: 1_000_000,
    fills: [1_000_000, 1_000_000],
  },
  // Volume 7 with an inside long at 3000 needed: 3000 D7 S7; 1000 D7 S3; 6000 D4 S7.
  {
    name: "inside orders needed for the volume",
    orders: [L(0, 4, 6000), L(1, 3, 3000), S(2, 3, 1000), S(3, 4, 3000)],
    price: 3000,
    volume: 7,
    fills: [4, 3, 3, 4],
  },
];

for (const c of cases) {
  test(`clearing: ${c.name}`, () => {
    assert.deepEqual(clearRound(c.orders, TICK), { price: c.price, volume: c.volume, fills: c.fills });
  });
}

test("there are at least 30 hand-worked clearing cases", () => {
  assert.ok(cases.length >= 30, `${cases.length} cases`);
});

test("clearing does not depend on the order of the input", () => {
  const c = cases.find((x) => x.name === "demand above at lo, supply above at hi")!;
  const reversed = [...c.orders].reverse();
  assert.deepEqual(clearRound(reversed, TICK), { price: c.price, volume: c.volume, fills: [...c.fills].reverse() });
});

test("clearing rejects orders that reveal would have rejected", () => {
  assert.throws(() => clearRound([L(0, 1, 1500)], TICK), /multiple of tick/);
  assert.throws(() => clearRound([L(0, 1, 0)], TICK), /multiple of tick/);
  assert.throws(() => clearRound([L(0, 0, 1000)], TICK), /size/);
});

test("curves are steps at each distinct price", () => {
  const orders = [L(0, 3, 6000), L(1, 3, 4000), S(2, 2, 3000), S(3, 5, 6000)];
  assert.deepEqual(curves(orders), [
    { price: 3000, demand: 6, supply: 2 },
    { price: 4000, demand: 6, supply: 2 },
    { price: 6000, demand: 3, supply: 7 },
  ]);
  assert.deepEqual(curves([]), []);
});
