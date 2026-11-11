// Hand-worked weeks. Prices are micro-USD per GPU-hour; $2.000 = 2_000_000.
//
// anchor $2.000, band_bps 2000, tick $0.001:
//   mid = 2.000, half = 0.400, floor = 1.600, band = 0.800, cap = 2.400
//   neutral LONG price p = half = 0.400, forward = floor + p = 2.000

import { test } from "node:test";
import assert from "node:assert/strict";
import { atBand, hedge, longPrice } from "../src/backtest/model.ts";
import type { WeekCore } from "../src/backtest/model.ts";

const core = (anchor: number, fixing: number): WeekCore => ({ week: "2025-03-03", anchorDay: "2025-02-22", anchor, prints: 7, fixing });

test("band from the anchor", () => {
  const w = atBand(core(2_000_000, 2_000_000), 2000);
  assert.deepEqual([w.mid, w.half, w.floor, w.band, w.cap], [2_000_000, 400_000, 1_600_000, 800_000, 2_400_000]);
});

test("band rounds the anchor and the half-width down to the tick", () => {
  // half = 2_345_678 * 1500 / 10000 = 351_851.7 -> 351_851 -> 351_000 on the tick
  const w = atBand(core(2_345_678, 2_345_678), 1500);
  assert.deepEqual([w.mid, w.half, w.floor, w.band], [2_345_000, 351_000, 1_994_000, 702_000]);
});

test("inside the band: the hedged buyer pays exactly the forward", () => {
  const w = atBand(core(2_000_000, 2_100_000), 2000);
  assert.equal(w.inside, true);
  assert.equal(w.longPayout, 500_000); // 2.100 - 1.600
  assert.equal(w.shortPayout, 300_000);
  const h = hedge(w, longPrice(w, 0));
  assert.equal(h.p, 400_000);
  assert.equal(h.buyerUnhedged, 2_100_000);
  assert.equal(h.buyerHedged, 2_000_000); // 2.100 - 0.500 + 0.400
  assert.equal(h.sellerHedged, 2_000_000); // 2.100 + 0.300 - (0.800 - 0.400)
  assert.equal(h.buyerLock, 400_000);
  assert.equal(h.sellerLock, 400_000);
  // 1,344 GPU-hours at $2.000
  assert.equal((h.buyerHedged * 1344) / 1e6, 2688);
});

test("above the cap: LONG pays the whole band and the buyer bears the excess", () => {
  const w = atBand(core(2_000_000, 2_600_000), 2000);
  assert.equal(w.inside, false);
  assert.equal(w.longPayout, 800_000);
  assert.equal(w.shortPayout, 0);
  const h = hedge(w, w.half);
  assert.equal(h.buyerHedged, 2_200_000); // 2.600 - 0.800 + 0.400 = forward + (fixing - cap)
  assert.equal(h.sellerHedged, 2_200_000); // 2.600 + 0 - 0.400
});

test("below the floor: SHORT pays the whole band and the seller bears the shortfall", () => {
  const w = atBand(core(2_000_000, 1_500_000), 2000);
  assert.equal(w.inside, false);
  assert.equal(w.longPayout, 0);
  assert.equal(w.shortPayout, 800_000);
  const h = hedge(w, w.half);
  assert.equal(h.buyerHedged, 1_900_000); // 1.500 - 0 + 0.400
  assert.equal(h.sellerHedged, 1_900_000); // 1.500 + 0.800 - 0.400 = forward - (floor - fixing)
});

test("fixing exactly on the floor or the cap counts as inside", () => {
  assert.equal(atBand(core(2_000_000, 1_600_000), 2000).inside, true);
  assert.equal(atBand(core(2_000_000, 2_400_000), 2000).inside, true);
  assert.equal(atBand(core(2_000_000, 2_400_001), 2000).inside, false);
});

test("forward shifted off the anchor", () => {
  const w = atBand(core(2_000_000, 2_000_000), 2000);
  assert.equal(longPrice(w, 0.05), 500_000); // forward 2.100
  assert.equal(longPrice(w, -0.02), 360_000); // forward 1.960
  const h = hedge(w, longPrice(w, 0.05));
  assert.equal(h.forward, 2_100_000);
  assert.equal(h.buyerHedged, 2_100_000);
  assert.equal(h.sellerLock, 300_000);
  // a shift past the band edge is clamped one tick inside it
  const narrow = atBand(core(2_000_000, 2_000_000), 1000);
  assert.equal(longPrice(narrow, 0.5), narrow.band - 1000);
});

test("hedging a provider's own price with the index (basis)", () => {
  const w = atBand(core(2_000_000, 2_100_000), 2000);
  // provider charged $2.500 while the index fixed at $2.100
  const h = hedge(w, w.half, 2_500_000);
  assert.equal(h.buyerHedged, 2_400_000); // 2.500 - 0.500 + 0.400: forward plus the basis
});
