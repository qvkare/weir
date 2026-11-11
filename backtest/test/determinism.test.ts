// The backtest run twice from the committed derived files gives the same bytes, and
// those bytes are the committed results/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBacktest } from "../src/backtest/run.ts";
import { DERIVED, RESULTS } from "../src/lib/paths.ts";

test("two runs produce byte-identical results that match the committed ones", () => {
  const a = mkdtempSync(join(tmpdir(), "weir-bt-a-"));
  const b = mkdtempSync(join(tmpdir(), "weir-bt-b-"));
  try {
    runBacktest(DERIVED, a);
    runBacktest(DERIVED, b);
    const files = readdirSync(a).sort();
    assert.deepEqual(files, ["site.json", "summary.json", "summary.md", "weeks.csv"]);
    assert.deepEqual(readdirSync(b).sort(), files);
    for (const f of files) {
      const x = readFileSync(join(a, f));
      assert.ok(x.equals(readFileSync(join(b, f))), `${f} differs between runs`);
      assert.ok(x.equals(readFileSync(join(RESULTS, f))), `${f} differs from the committed results/; re-run the backtest`);
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
