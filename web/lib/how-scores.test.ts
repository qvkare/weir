import assert from "node:assert/strict";
import { test } from "node:test";
import { clearingScore, commitScore, fundingScore, seriesClockScore, settlementScore } from "./how-scores.ts";
import { checkScore } from "./motion.ts";

const all = {
  clock: seriesClockScore({ lead: "169 h", commit: "45 m", reveal: "15 m", cutoff: "1 h", period: "7 d", grace: "15 m", rounds: 8 }),
  commit: commitScore(),
  clearing: clearingScore({ price: "$0.40", fills: "A fills 10." }),
  settlement: settlementScore(7, { band: "$2.00 to $2.80", fixing: "$2.55", long: "$0.55", short: "$0.25" }),
  funding: fundingScore(false),
};

test("every /how score is sound, short, and has one caption per step", () => {
  for (const [name, s] of Object.entries(all)) {
    assert.deepEqual(checkScore(s), [], name);
    assert.ok(s.total <= 8_000, `${name} is short`);
    assert.ok(s.beats.length >= 4 && s.beats.length <= 5, `${name} has 4 or 5 steps`);
  }
});

test("each step's parts appear inside that step, so stepping by hand shows them complete", () => {
  for (const [name, s] of Object.entries(all)) {
    for (const t of s.tracks) {
      const i = s.beats.findLastIndex((b) => b.at <= t.start);
      const end = s.beats[i + 1]?.at ?? s.total;
      assert.ok(t.start + t.duration <= end + 1, `${name}: ${t.target} spills into the next step`);
    }
  }
});

test("captions carry the figures they are given", () => {
  assert.match(all.settlement.beats[2]!.label, /\$2\.55/);
  assert.match(all.clearing.beats[3]!.label, /\$0\.40/);
  assert.match(all.funding.beats[1]!.label, /No transfer is on record yet/);
  assert.doesNotMatch(fundingScore(true).beats[1]!.label, /No transfer/);
});
