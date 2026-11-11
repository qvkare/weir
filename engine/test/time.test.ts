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

// Series 0: delivery [1_000_000, 1_003_600), auctions [998_200, 1_003_000), rounds of 180 s.
// Round r exists while 998_200 + (r + 1) * 180 <= 1_003_000, so rounds 0..25; round 25 ends at 1_002_880.
const P: TimeParams = { t0: 1_000_000, periodSecs: 3600, leadSecs: 1800, cutoffSecs: 600, commitSecs: 120, revealSecs: 60 };

test("series window arithmetic", () => {
  assert.equal(deliveryStart(P, 0), 1_000_000);
  assert.equal(deliveryEnd(P, 0), 1_003_600);
  assert.equal(auctionOpen(P, 0), 998_200);
  assert.equal(auctionClose(P, 0), 1_003_000);
  assert.equal(deliveryStart(P, 2), 1_007_200);
  assert.equal(roundStart(P, 0, 25), 1_002_700);
  assert.equal(roundCount(P, 0), 26);
  assert.ok(roundExists(P, 0, 25));
  assert.ok(!roundExists(P, 0, 26));
});

test("auction_open saturates at zero", () => {
  const early = { ...P, t0: 100 };
  assert.equal(auctionOpen(early, 0), 0);
  assert.equal(roundStart(early, 0, 1), 180);
  assert.deepEqual(phaseAt(early, 0, 0), { round: 0, phase: "Commit" });
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
    [1_002_700, 25, "Commit"],
    [1_002_819, 25, "Commit"],
    [1_002_820, 25, "Reveal"],
    [1_002_879, 25, "Reveal"],
    [1_002_880, null, "Closed"],
    [1_002_999, null, "Closed"],
    [1_003_000, null, "Closed"],
    [2_000_000, null, "Closed"],
  ];
  for (const [now, round, phase] of cases) {
    assert.deepEqual(phaseAt(P, 0, now), { round, phase }, `now = ${now}`);
  }
});

test("a round ending exactly at auction_close exists", () => {
  // 4800 s of auctions split into rounds of 160 s: exactly 30 rounds, the last ends at close.
  const exact = { ...P, commitSecs: 100 };
  assert.equal(roundCount(exact, 0), 30);
  assert.ok(roundExists(exact, 0, 29));
  assert.deepEqual(phaseAt(exact, 0, 1_002_999), { round: 29, phase: "Reveal" });
});

test("phase end times", () => {
  assert.equal(phaseEndsAt(P, 0, phaseAt(P, 0, 998_200)), 998_320);
  assert.equal(phaseEndsAt(P, 0, phaseAt(P, 0, 998_320)), 998_380);
  assert.equal(phaseEndsAt(P, 0, phaseAt(P, 0, 1_002_900)), null);
});

test("live series and series of a time", () => {
  assert.deepEqual(liveSeries(P, 998_199), []);
  assert.deepEqual(liveSeries(P, 998_200), [0]);
  // Series 1 opens at 1_001_800 while series 0 runs until 1_003_000.
  assert.deepEqual(liveSeries(P, 1_001_800), [0, 1]);
  assert.deepEqual(liveSeries(P, 1_003_000), [1]);
  // A lead longer than a period makes three windows overlap.
  assert.deepEqual(liveSeries({ ...P, leadSecs: 8000 }, 1_003_000), [1, 2, 3]);
  assert.equal(seriesOf(P, 999_999), null);
  assert.equal(seriesOf(P, 1_000_000), 0);
  assert.equal(seriesOf(P, 1_003_599), 0);
  assert.equal(seriesOf(P, 1_003_600), 1);
});
