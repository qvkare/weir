import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auctionClose,
  auctionOpen,
  deliveryEnd,
  deliveryStart,
  liveSeries,
  phaseAt,
  phaseEndsAt,
  roundCount,
  roundExists,
  roundStart,
  seriesOf,
  type TimeParams,
} from "../src/mod.ts";
import { Rng } from "./prng.ts";

// Series 0: delivery [1_000_000, 1_003_600), auctions [998_200, 999_400), rounds of 180 s.
// Round r exists while 998_200 + (r + 1) * 180 <= 999_400, so rounds 0..5; round 5 ends at 999_280.
const P: TimeParams = { t0: 1_000_000, periodSecs: 3600, leadSecs: 1800, cutoffSecs: 600, commitSecs: 120, revealSecs: 60 };

test("series window arithmetic", () => {
  assert.equal(deliveryStart(P, 0), 1_000_000);
  assert.equal(deliveryEnd(P, 0), 1_003_600);
  assert.equal(auctionOpen(P, 0), 998_200);
  assert.equal(auctionClose(P, 0), 999_400);
  assert.equal(auctionClose(P, 1), 1_003_000);
  assert.equal(deliveryStart(P, 2), 1_007_200);
  assert.equal(roundStart(P, 0, 5), 999_100);
  assert.equal(roundCount(P, 0), 6);
  assert.ok(roundExists(P, 0, 5));
  assert.ok(!roundExists(P, 0, 6));
  // With no cutoff, auctions run right up to delivery.
  assert.equal(auctionClose({ ...P, cutoffSecs: 0 }, 0), 1_000_000);
});

test("auction_open and auction_close saturate at zero", () => {
  const none = { ...P, t0: 100 };
  assert.deepEqual([auctionOpen(none, 0), auctionClose(none, 0), roundCount(none, 0)], [0, 0, 0]);
  assert.deepEqual(phaseAt(none, 0, 0), { round: null, phase: "Closed" });
  // Auctions over [0, 400): two whole rounds.
  const early = { ...P, t0: 1000 };
  assert.deepEqual([auctionOpen(early, 0), auctionClose(early, 0), roundCount(early, 0)], [0, 400, 2]);
  assert.deepEqual(phaseAt(early, 0, 0), { round: 0, phase: "Commit" });
  assert.deepEqual(phaseAt(early, 0, 360), { round: null, phase: "Closed" });
});

test("phase boundaries to the second", () => {
  const cases: [number, number | null, string][] = [
    [998_199, null, "Closed"],
    [998_200, 0, "Commit"],
    [998_319, 0, "Commit"],
    [998_320, 0, "Reveal"],
    [998_379, 0, "Reveal"],
    [998_380, 1, "Commit"],
    [998_500, 1, "Reveal"],
    [999_100, 5, "Commit"],
    [999_219, 5, "Commit"],
    [999_220, 5, "Reveal"],
    [999_279, 5, "Reveal"],
    [999_280, null, "Closed"],
    [999_399, null, "Closed"],
    [999_400, null, "Closed"],
    [1_000_000, null, "Closed"],
    [2_000_000, null, "Closed"],
  ];
  for (const [now, round, phase] of cases) {
    assert.deepEqual(phaseAt(P, 0, now), { round, phase }, `now = ${now}`);
  }
});

test("a round ending exactly at auction_close exists", () => {
  // 1200 s of auctions split into rounds of 200 s: exactly 6 rounds, the last ends at close.
  const exact = { ...P, commitSecs: 140 };
  assert.equal(roundCount(exact, 0), 6);
  assert.ok(roundExists(exact, 0, 5));
  assert.deepEqual(phaseAt(exact, 0, 999_399), { round: 5, phase: "Reveal" });
  assert.deepEqual(phaseAt(exact, 0, 999_400), { round: null, phase: "Closed" });
});

test("phase end times", () => {
  assert.equal(phaseEndsAt(P, 0, phaseAt(P, 0, 998_200)), 998_320);
  assert.equal(phaseEndsAt(P, 0, phaseAt(P, 0, 998_320)), 998_380);
  assert.equal(phaseEndsAt(P, 0, phaseAt(P, 0, 999_300)), null);
});

test("live series and series of a time", () => {
  assert.deepEqual(liveSeries(P, 998_199), []);
  assert.deepEqual(liveSeries(P, 998_200), [0]);
  assert.deepEqual(liveSeries(P, 999_399), [0]);
  // Between series 0's close and series 1's open nothing is in auction.
  assert.deepEqual(liveSeries(P, 999_400), []);
  assert.deepEqual(liveSeries(P, 1_001_800), [1]);
  // A lead much longer than a period makes windows overlap.
  assert.deepEqual(liveSeries({ ...P, leadSecs: 8000 }, 1_003_000), [2, 3]);
  assert.equal(seriesOf(P, 999_999), null);
  assert.equal(seriesOf(P, 1_000_000), 0);
  assert.equal(seriesOf(P, 1_003_599), 0);
  assert.equal(seriesOf(P, 1_003_600), 1);
});

test("with lead = period + cutoff exactly one series is in auction at a time", () => {
  const rng = new Rng(4);
  for (let run = 0; run < 200; run++) {
    const periodSecs = rng.int(1, 5000);
    const cutoffSecs = rng.int(0, 3000);
    const p: TimeParams = {
      t0: rng.int(0, 1_000_000),
      periodSecs,
      leadSecs: periodSecs + cutoffSecs,
      cutoffSecs,
      commitSecs: rng.int(1, 100),
      revealSecs: rng.int(1, 100),
    };
    // close(s) and open(s + 1) are the same saturated value, so from series 0's open the
    // windows tile time with no gap.
    const from = auctionOpen(p, 0);
    for (let k = 0; k < 50; k++) {
      const now = from + (rng.chance(0.1) ? rng.int(0, 10) : rng.int(0, 20 * periodSecs));
      const live = liveSeries(p, now);
      assert.equal(live.length, 1, `run ${run} now ${now}: ${JSON.stringify({ p, live })}`);
      const s = live[0]!;
      assert.ok(auctionOpen(p, s) <= now && now < auctionClose(p, s));
      assert.equal(auctionClose(p, s), auctionOpen(p, s + 1));
    }
  }
  // At every second of a few windows, including both edges of each.
  const q = { ...P, leadSecs: 4200 };
  assert.deepEqual(liveSeries(q, auctionOpen(q, 0) - 1), []);
  for (let now = auctionOpen(q, 0); now < auctionOpen(q, 4); now++) assert.equal(liveSeries(q, now).length, 1, `now ${now}`);
});
