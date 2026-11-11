import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKETS } from "../../agents/src/presets.ts";
import { auctionClose, auctionOpen, phaseAt, type TimeParams } from "../../engine/src/mod.ts";
import { chooseT0, FIRST_MONDAY } from "../src/t0.ts";

const fast = MARKETS["h100-fast"].params;
const weekly = MARKETS["h100-weekly"].params;
const tp = (p: typeof fast, t0: number): TimeParams => ({ t0, periodSecs: p.period_secs, leadSecs: p.lead_secs, cutoffSecs: p.cutoff_secs, commitSecs: p.commit_secs, revealSecs: p.reveal_secs });
const at = (iso: string) => Date.parse(iso) / 1000;

test("1970-01-05 was a Monday", () => {
  assert.equal(new Date(FIRST_MONDAY * 1000).getUTCDay(), 1);
  assert.equal(FIRST_MONDAY % 86_400, 0);
});

test("fast market: t0 on the hour, series 0 in auction at now (engine's own time functions agree)", () => {
  const cases: [string, string][] = [
    // now, expected t0
    ["2026-11-12T08:00:00Z", "2026-11-12T09:00:00Z"], // exactly on the hour
    ["2026-11-12T08:54:59Z", "2026-11-12T09:00:00Z"], // one second before series 0's auctions close
    ["2026-11-12T08:55:00Z", "2026-11-12T10:00:00Z"], // the moment they close: the next hour's series is in auction
    ["2026-11-12T08:55:01Z", "2026-11-12T10:00:00Z"],
    ["2026-11-12T08:59:59Z", "2026-11-12T10:00:00Z"], // just before a boundary
    ["2026-11-12T09:00:01Z", "2026-11-12T10:00:00Z"], // just after one
    ["2026-11-12T23:57:00Z", "2026-11-13T01:00:00Z"], // across midnight
  ];
  for (const [now, want] of cases) {
    const c = chooseT0(fast, at(now));
    assert.equal(c.t0, at(want), now);
    assert.equal(c.t0 % 3600, 0);
    assert.equal(c.t0 % fast.print_interval_secs, 0);
    const p = tp(fast, c.t0);
    assert.ok(auctionOpen(p, 0) <= at(now) && at(now) < auctionClose(p, 0), `${now} is in series 0's window`);
    assert.notEqual(phaseAt(p, 0, at(now)).phase, "Closed", `${now}: a round of series 0 is under way`);
    // No earlier aligned t0 would also have an open window: series 0 is the series in auction.
    assert.ok(at(now) >= auctionClose(tp(fast, c.t0 - 3600), 0));
  }
});

test("weekly markets: t0 on Monday 00:00 UTC, series 0 in auction at now", () => {
  const cases: [string, string][] = [
    ["2026-11-12T08:00:00Z", "2026-11-16T00:00:00Z"], // Thursday
    ["2026-11-15T22:59:59Z", "2026-11-16T00:00:00Z"], // a second before the auctions close (Sunday 23:00)
    ["2026-11-15T23:00:00Z", "2026-11-23T00:00:00Z"], // they close: next Monday's series
    ["2026-11-15T23:59:59Z", "2026-11-23T00:00:00Z"], // just before a Monday
    ["2026-11-16T00:00:00Z", "2026-11-23T00:00:00Z"], // on a Monday
    ["2026-11-16T00:00:01Z", "2026-11-23T00:00:00Z"], // just after
    ["2026-12-31T12:00:00Z", "2027-01-04T00:00:00Z"], // across a year
  ];
  for (const [now, want] of cases) {
    const c = chooseT0(weekly, at(now));
    assert.equal(c.t0, at(want), now);
    assert.equal(new Date(c.t0 * 1000).getUTCDay(), 1, `${now}: a Monday`);
    assert.equal(c.t0 % 86_400, 0);
    assert.equal(c.t0 % weekly.print_interval_secs, 0);
    const p = tp(weekly, c.t0);
    assert.ok(auctionOpen(p, 0) <= at(now) && at(now) < auctionClose(p, 0), `${now} is in series 0's window`);
    assert.notEqual(phaseAt(p, 0, at(now)).phase, "Closed");
  }
});

test("every second of an hour gives a valid fast t0", () => {
  const base = at("2026-11-12T08:00:00Z");
  for (let s = 0; s < 3600; s++) {
    const c = chooseT0(fast, base + s);
    assert.ok(c.auctionOpen <= base + s && base + s < c.auctionClose);
  }
});

test("a period with no natural boundary is refused", () => {
  assert.throws(() => chooseT0({ ...fast, period_secs: 1800, lead_secs: 2100 }, 0), /no natural boundary/);
});
