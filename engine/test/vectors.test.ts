// Shared vectors written from the Rust contract. The engine must reproduce every case
// exactly. A missing file fails, unless WEIR_ALLOW_MISSING_VECTORS=1 turns it into a skip.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { clearRound, commitHash, computeBand, phaseAt, printDecision, settleSeries, type Order, type Side } from "../src/mod.ts";

const DIR = new URL("../../vectors/", import.meta.url);

function vectors<T>(file: string, run: (data: T) => void): void {
  test(`vectors: ${file}`, (t) => {
    const url = new URL(file, DIR);
    if (!existsSync(url)) {
      const message = `missing vectors file ${url.pathname}`;
      if (process.env["WEIR_ALLOW_MISSING_VECTORS"] === "1") {
        t.diagnostic(message);
        t.skip(message);
        return;
      }
      assert.fail(message);
    }
    run(JSON.parse(readFileSync(url, "utf8")) as T);
  });
}

/** Runs every case and reports all mismatches at once, each with the case that failed. */
function each<C>(cases: readonly C[], label: (c: C, i: number) => string, check: (c: C) => void): void {
  assert.ok(cases.length > 0, "the file has no cases");
  const failures: string[] = [];
  cases.forEach((c, i) => {
    try {
      check(c);
    } catch (e) {
      failures.push(`${label(c, i)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  assert.equal(failures.length, 0, `${failures.length} of ${cases.length} cases differ:\n${failures.join("\n")}`);
}

interface ClearingFile {
  tick: number;
  cases: { name: string; orders: Order[]; expect: { price: number | null; volume: number; fills: number[] } }[];
}

vectors<ClearingFile>("clearing.json", ({ tick, cases }) =>
  each(cases, (c) => c.name, (c) => assert.deepEqual(clearRound(c.orders, tick), c.expect)),
);

interface HashFile {
  cases: { series: number; round: number; account_id: string; side: Side; size: number; price: number; salt: string; hash: string }[];
}

vectors<HashFile>("hash.json", ({ cases }) =>
  each(
    cases,
    (c, i) => `case ${i} (${c.account_id})`,
    (c) => assert.equal(commitHash({ ...c, accountId: c.account_id }), c.hash),
  ),
);

interface BandFile {
  cases: {
    anchor: number;
    tick: number;
    band_bps: number;
    expect: { mid: number; half: number; floor: number; band: number } | { error: true };
  }[];
}

vectors<BandFile>("band.json", ({ cases }) =>
  each(
    cases,
    (c) => `anchor ${c.anchor} tick ${c.tick} band_bps ${c.band_bps}`,
    (c) => {
      if ("error" in c.expect) assert.throws(() => computeBand(c.anchor, c.tick, c.band_bps));
      else assert.deepEqual(computeBand(c.anchor, c.tick, c.band_bps), c.expect);
    },
  ),
);

interface PrintFile {
  cases: {
    reports: number[];
    last: number | null;
    quorum: number;
    reporters: number;
    max_move_bps: number;
    expect: { final: boolean; price: number | null };
  }[];
}

vectors<PrintFile>("print.json", ({ cases }) =>
  each(
    cases,
    (c, i) => `case ${i} ${JSON.stringify(c.reports)} last ${c.last}`,
    (c) =>
      assert.deepEqual(
        printDecision({ reports: c.reports, last: c.last, quorum: c.quorum, reporters: c.reporters, maxMoveBps: c.max_move_bps }),
        c.expect,
      ),
  ),
);

interface SettlementFile {
  cases: {
    floor: number;
    band: number;
    sum: string;
    count: number;
    open_sets: number;
    pool: string;
    void_allowed: boolean;
    min_prints: number;
    expect:
      | {
          fixing: number;
          long_payout: number;
          short_payout: number;
          bonus_long: string;
          bonus_short: string;
          carry: string;
          void: boolean;
        }
      | { error: string };
  }[];
}

vectors<SettlementFile>("settlement.json", ({ cases }) =>
  each(
    cases,
    (c, i) => `case ${i} sum ${c.sum} count ${c.count} open_sets ${c.open_sets} pool ${c.pool}`,
    (c) => {
      const run = () =>
        settleSeries({
          floor: c.floor,
          band: c.band,
          sum: BigInt(c.sum),
          count: c.count,
          openSets: c.open_sets,
          pool: BigInt(c.pool),
          voidAllowed: c.void_allowed,
          minPrints: c.min_prints,
        });
      if ("error" in c.expect) {
        assert.throws(run, { message: c.expect.error });
        return;
      }
      const out = run();
      assert.deepEqual(
        {
          fixing: out.fixing,
          long_payout: out.longPayout,
          short_payout: out.shortPayout,
          bonus_long: out.bonusLong.toString(),
          bonus_short: out.bonusShort.toString(),
          carry: out.carry.toString(),
          void: out.void,
        },
        c.expect,
      );
    },
  ),
);

interface TimeFile {
  params: { t0: number; period_secs: number; lead_secs: number; cutoff_secs: number; commit_secs: number; reveal_secs: number };
  cases: { series: number; now: number; expect: { round: number | null; phase: "Commit" | "Reveal" | "Closed" } }[];
}

vectors<TimeFile>("time.json", ({ params: p, cases }) => {
  const params = {
    t0: p.t0,
    periodSecs: p.period_secs,
    leadSecs: p.lead_secs,
    cutoffSecs: p.cutoff_secs,
    commitSecs: p.commit_secs,
    revealSecs: p.reveal_secs,
  };
  each(
    cases,
    (c) => `series ${c.series} now ${c.now}`,
    (c) => assert.deepEqual(phaseAt(params, c.series, c.now), c.expect),
  );
});
