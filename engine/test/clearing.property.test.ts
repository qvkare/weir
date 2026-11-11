import assert from "node:assert/strict";
import { test } from "node:test";
import { clearRound, type Order } from "../src/mod.ts";
import { Rng } from "./prng.ts";

const TICK = 1000;
const MAX_TICKS = 12;

function randomOrders(rng: Rng): Order[] {
  const n = rng.int(0, 14);
  // Seqs are a shuffled range so array order and seq order disagree.
  const seqs = rng.shuffle([...Array(n).keys()]);
  return seqs.map((seq) => ({
    seq,
    side: rng.chance(0.5) ? "Long" : "Short",
    size: rng.int(1, rng.chance(0.2) ? 50 : 6),
    price: rng.int(1, MAX_TICKS) * TICK,
  }));
}

const volumeAt = (orders: readonly Order[], p: number): number => {
  let d = 0;
  let s = 0;
  for (const o of orders) {
    if (o.side === "Long" && o.price >= p) d += o.size;
    if (o.side === "Short" && o.price <= p) s += o.size;
  }
  return Math.min(d, s);
};

test("invariants 3 and 4 hold for 5,000 random rounds", () => {
  const rng = new Rng(0x5eed);
  let traded = 0;
  for (let run = 0; run < 5000; run++) {
    const orders = randomOrders(rng);
    const { price, volume, fills } = clearRound(orders, TICK);
    const where = `run ${run}: ${JSON.stringify(orders)}`;
    assert.equal(fills.length, orders.length, where);

    // Invariant 3: fills balance, stay within size and respect every limit.
    let longFill = 0;
    let shortFill = 0;
    orders.forEach((o, i) => {
      const f = fills[i]!;
      assert.ok(Number.isInteger(f) && f >= 0 && f <= o.size, where);
      if (f === 0) return;
      assert.ok(price !== null, where);
      if (o.side === "Long") {
        longFill += f;
        assert.ok(o.price >= price, where);
      } else {
        shortFill += f;
        assert.ok(o.price <= price, where);
      }
    });
    assert.equal(longFill, volume, where);
    assert.equal(shortFill, volume, where);

    // Invariant 4, by brute force over every tick price in range and one beyond each end.
    let best = 0;
    for (let k = 0; k <= MAX_TICKS + 1; k++) best = Math.max(best, volumeAt(orders, k * TICK));
    assert.equal(volume, best, where);
    if (price === null) {
      assert.equal(volume, 0, where);
      continue;
    }
    traded++;
    assert.equal(price % TICK, 0, where);
    assert.equal(volumeAt(orders, price), volume, where);

    // Priority: an order with a strictly better claim is never left short while a worse one fills.
    for (const side of ["Long", "Short"] as const) {
      const better = (a: Order, b: Order) =>
        (side === "Long" ? a.price > b.price : a.price < b.price) || (a.price === b.price && a.seq < b.seq);
      orders.forEach((a, i) => {
        orders.forEach((b, j) => {
          if (a.side !== side || b.side !== side || !better(a, b) || fills[j] === 0) return;
          assert.equal(fills[i], a.size, `${where}: order ${i} should fill before ${j}`);
        });
      });
    }
  }
  assert.ok(traded > 2000, `only ${traded} rounds traded`);
});
