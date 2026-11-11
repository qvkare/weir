// Strategies: every bid is valid for the band, the tick and the balance; the buyer's and
// seller's reservation prices on hand-worked cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS } from "../src/presets.ts";
import { mulberry32 } from "../src/random.ts";
import { buyer, maker, noise, seller } from "../src/strategies/mod.ts";
import { fairLong, fit, forecast, lockOf, type AgentView } from "../src/strategy.ts";

const params = PRESETS.fast;

function view(over: Partial<AgentView> = {}): AgentView {
  return {
    params,
    now: params.t0 - 1000,
    series: 0,
    floor: 1_600_000,
    band: 800_000,
    round: 2,
    roundsLeft: 10,
    lastPrint: { bucket: params.t0 - 1200, price: 2_000_000 },
    prints: [],
    accumulator: { sum: "0", count: 0 },
    position: { long: 0, short: 0 },
    free: 1_000_000_000n,
    results: [],
    ...over,
  };
}

test("forecast: the last print before delivery, then known prints plus the last print for the rest", () => {
  assert.equal(forecast(view()), 2_000_000);
  // 12 prints per period; 6 known at $2.10, the last print $2.00 for the other 6.
  const v = view({ accumulator: { sum: String(6 * 2_100_000), count: 6 } });
  assert.equal(forecast(v), 2_050_000);
  assert.equal(fairLong(v), 450_000);
  assert.equal(forecast(view({ accumulator: { sum: String(12 * 2_300_000), count: 12 } })), 2_300_000);
  assert.equal(fairLong(view({ lastPrint: { bucket: 0, price: 3_000_000 } })), 800_000, "clamped to the band");
  assert.equal(forecast(view({ lastPrint: null })), null);
});

test("buyer: forecast plus its premium, its unhedged need spread over the rounds left", () => {
  const b = buyer("b", { need: 40, premiumBps: 500 });
  // fair 400_000 + 5% of 800_000 = 440_000; 40 hours over 10 rounds = 4.
  assert.deepEqual(b.decide(view(), Math.random), [{ side: "Long", size: 4, price: 440_000 }]);
  // 37 already hedged: 3 left over 10 rounds rounds up to 1, raised to the smallest order that locks $1 (3 x $0.44).
  assert.deepEqual(b.decide(view({ position: { long: 37, short: 0 } }), Math.random), [{ side: "Long", size: 3, price: 440_000 }]);
  assert.deepEqual(b.decide(view({ position: { long: 39, short: 0 }, roundsLeft: 1 }), Math.random), [], "1 hour is below min_lock");
  assert.deepEqual(b.decide(view({ position: { long: 40, short: 0 } }), Math.random), []);
  // Only $1.40 free: room for 3 units at $0.44, locking exactly $1.32, plus the $0.02 fee.
  assert.deepEqual(b.decide(view({ free: 1_400_000n }), Math.random), [{ side: "Long", size: 3, price: 440_000 }]);
  assert.deepEqual(b.decide(view({ free: 900_000n }), Math.random), [], "2 units would lock $0.88, below min_lock");
  // A premium rounding off the tick rounds down for a LONG: never pays more than asked.
  assert.deepEqual(buyer("b", { need: 40, premiumBps: 333 }).decide(view(), Math.random)[0]!.price, 426_000);
});

test("seller: forecast minus its premium, rounded up for a SHORT, symmetric to the buyer", () => {
  const s = seller("s", { capacity: 200, premiumBps: 500 });
  assert.deepEqual(s.decide(view(), Math.random), [{ side: "Short", size: 20, price: 360_000 }]);
  assert.deepEqual(seller("s", { capacity: 200, premiumBps: 333 }).decide(view(), Math.random)[0]!.price, 374_000);
  assert.deepEqual(s.decide(view({ position: { long: 0, short: 200 } }), Math.random), []);
  // A forecast at the floor would ask for a LONG price of 0: kept one tick inside the band.
  assert.deepEqual(s.decide(view({ lastPrint: { bucket: 0, price: 1_500_000 } }), Math.random)[0]!.price, 1000);
});

test("maker quotes both sides around fair value; noise follows its random view", () => {
  const m = maker("m", { spreadBps: 1000, shareBps: 1000, maxSize: 40 });
  const [bid, ask] = m.decide(view(), Math.random);
  assert.deepEqual(bid, { side: "Long", size: 40, price: 360_000 });
  assert.deepEqual(ask, { side: "Short", size: 40, price: 440_000 });
  const n = noise("n", { viewBps: 1000, minSize: 2, maxSize: 8 });
  const values = [0.9, 0.5]; // view +8% of the band above fair, size 2 + floor(0.5 * 7) = 5
  const orders = n.decide(view(), () => values.shift()!);
  assert.deepEqual(orders, [{ side: "Long", size: 5, price: 464_000 }]);
});

test("5,000 random views: every order is on the tick, strictly inside the band, within max size, and the balance covers every lock and its fee", () => {
  const r = mulberry32(99);
  const strategies = [
    buyer("b", { need: 60, premiumBps: 800 }),
    seller("s", { capacity: 240, premiumBps: 200 }),
    maker("m", { spreadBps: 400, shareBps: 1000, maxSize: 40 }),
    noise("n", { viewBps: 1000, minSize: 2, maxSize: 8 }),
  ];
  let orders = 0;
  for (let i = 0; i < 5000; i++) {
    const half = 1000 * (1 + Math.floor(r() * 600));
    const band = 2 * half;
    const v = view({
      band,
      floor: 1000 * Math.floor(r() * 3000),
      lastPrint: r() < 0.05 ? null : { bucket: 0, price: Math.floor(r() * 6_000_000) + 1 },
      accumulator: { sum: String(Math.floor(r() * 5) * 2_000_000), count: Math.floor(r() * 5) },
      position: { long: Math.floor(r() * 100), short: Math.floor(r() * 100) },
      roundsLeft: 1 + Math.floor(r() * 12),
      free: BigInt(Math.floor(r() * 300_000_000)),
    });
    for (const s of strategies) {
      const out = s.decide(v, r);
      let locked = 0n;
      for (const o of out) {
        orders++;
        assert.equal(o.price % params.tick, 0);
        assert.ok(o.price > 0 && o.price < band, `${s.id} price ${o.price} band ${band}`);
        assert.ok(Number.isInteger(o.size) && o.size >= 1 && o.size <= params.max_order_size);
        assert.ok(lockOf(o, band) >= BigInt(params.min_lock));
        locked += lockOf(o, band) + BigInt(params.commit_fee);
      }
      assert.ok(locked <= v.free, `${s.id} locks ${locked} of ${v.free}`);
    }
  }
  assert.ok(orders > 5000, `only ${orders} orders`);
});

test("fit drops what it cannot make valid and gives earlier intents the balance first", () => {
  // The fee rule: an order must lock at least 50 commit fees. With a 10-cent fee that is $5.
  const pricey = view({ params: { ...params, commit_fee: "100000" } });
  assert.deepEqual(fit(pricey, [{ side: "Long", size: 40, price: 100_000 }]), []);
  assert.deepEqual(fit(pricey, [{ side: "Long", size: 50, price: 100_000 }]), [{ side: "Long", size: 50, price: 100_000 }]);
  const v = view({ free: 5_000_000n });
  const out = fit(v, [
    { side: "Long", size: 30, price: 100_000 },
    { side: "Short", size: 30, price: 700_000 },
    { side: "Long", size: Number.NaN, price: 1 },
  ]);
  // $3.00 and a $0.02 fee for the LONG leave $1.98; less the next fee, 19 SHORT at $0.10 each.
  assert.deepEqual(out, [{ side: "Long", size: 30, price: 100_000 }, { side: "Short", size: 19, price: 700_000 }]);
  assert.deepEqual(fit(v, [{ side: "Long", size: 3, price: 100_000 }]), [], "$0.30 is below min_lock");
  assert.deepEqual(fit(v, [{ side: "Long", size: 2000, price: -5 }]), [{ side: "Long", size: 2000, price: 1000 }]);
});
