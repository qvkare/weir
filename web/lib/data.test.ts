import assert from "node:assert/strict";
import { test } from "node:test";
import { backtestGeometry, caveatsFromMarkdown, coverage, niceStep, readBacktest } from "./backtest.ts";
import { readCache, valueOf } from "./cache.ts";
import { marketFromParam, parseDeployments } from "./config.ts";
import { fundingStatus, groupTxs, readTxFile } from "./evidence.ts";

test("deployments.json: empty markets, defaults, and tolerant entries", () => {
  const d = parseDeployments({ network: "testnet", rpc: ["https://a.example", "http://insecure", 4], explorer: "https://x.io/", bundles_base: null, markets: [] });
  assert.deepEqual(d.rpc, ["https://a.example"]);
  assert.equal(d.explorer, "https://x.io");
  assert.equal(d.bundlesBase, null);
  assert.equal(d.markets.length, 0);
  const m = parseDeployments({ markets: [{ id: "fast", contract: "fast.weir.testnet", keeper: "k.testnet", reporters: ["r1.testnet"] }, { id: "fast", contract: "dup" }, { id: "nope", contract: "x" }, { name: "weekly", account_id: "w.testnet" }] });
  assert.deepEqual(m.markets.map((x) => [x.id, x.contract]), [["fast", "fast.weir.testnet"], ["weekly", "w.testnet"]]);
  assert.deepEqual(m.markets[0]!.accounts, [{ role: "keeper", account: "k.testnet" }, { role: "reporters", account: "r1.testnet" }]);
  assert.equal(parseDeployments(null).markets.length, 0);
  assert.equal(parseDeployments({ markets: { weekly: { contract: "w.testnet" } } }).markets[0]!.contract, "w.testnet");
});

test("market switcher param", () => {
  assert.equal(marketFromParam("fast"), "fast");
  assert.equal(marketFromParam(["fast", "weekly"]), "fast");
  assert.equal(marketFromParam("other"), "weekly");
  assert.equal(marketFromParam(undefined), "weekly");
});

test("the read cache serves fresh values and the last good one after a failure", async () => {
  let t = 0;
  const c = readCache(1000, 10, () => t);
  let calls = 0;
  const ok = await c.read("k", async () => ++calls);
  assert.deepEqual(ok, { ok: true, value: 1, at: 0 });
  t = 500;
  assert.equal(valueOf(await c.read("k", async () => ++calls)), 1);
  t = 2000;
  const bad = await c.read("k", async () => {
    throw new Error("down");
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(!bad.ok && bad.lastGood, { value: 1, at: 0 });
  assert.equal(valueOf(bad), 1);
  const none = await c.read("other", async () => {
    throw new Error("down");
  });
  assert.equal(valueOf(none), null);
});

test("evidence: tolerant transaction reader, failed ones kept", () => {
  const h = "8".repeat(44);
  const txs = readTxFile("evidence/a.json", { transactions: [{ hash: h, method: "commit", status: "SuccessValue", block_timestamp: 1_700_000_000_000_000_000 }, { tx_hash: "9".repeat(44), method_name: "reveal", ok: false }, { method: "x" }, "junk"] });
  assert.equal(txs.length, 2);
  assert.equal(txs[0]!.group, "commit");
  assert.equal(txs[0]!.ok, true);
  assert.equal(txs[0]!.at, 1_700_000_000);
  assert.equal(txs[1]!.ok, false);
  assert.deepEqual(readTxFile("f", null), []);
  assert.deepEqual(readTxFile("f", 42), []);
  const groups = groupTxs([...txs, txs[0]!]);
  assert.deepEqual(groups.map((g) => [g.group, g.txs.length]), [["commit", 1], ["reveal", 1]]);
});

test("funding is quotes only until a successful intents transfer is on record", () => {
  assert.deepEqual(fundingStatus([]), { tag: "quotes only" });
  const tx = readTxFile("f", [{ hash: "7".repeat(44), method: "intents_transfer", kind: "intents", ok: true }]);
  assert.equal(fundingStatus(tx).tag, "recorded");
  const failed = readTxFile("f", [{ hash: "7".repeat(44), method: "intents_transfer", ok: false }]);
  assert.equal(fundingStatus(failed).tag, "quotes only");
});

test("backtest: missing file, shapes, units, and nothing invented", () => {
  assert.equal(readBacktest(null, null), null);
  const b = readBacktest({ weeks: [
    { week: "2025-01-06", fixing: 2.5, floor: 2.0, cap: 3.0, hedged: 2.4, unhedged: 2.5 },
    { start: 1736726400, fixing: 3_400_000, floor: 2_000_000, band: 1_000_000, hedged: 2_600_000, unhedged: 3_400_000, inside_band: false },
    { week: "2025-01-20", floor: 2.0 },
  ], source: "x" }, { weeks: 2 })!;
  assert.equal(b.weeks.length, 2);
  assert.equal(b.dropped, 1);
  assert.equal(b.weeks[1]!.cap, 3);
  assert.equal(b.weeks[1]!.fixing, 3.4);
  assert.equal(b.weeks[0]!.inside, true);
  assert.equal(b.meta.source, "x");
  const c = coverage(b.weeks);
  assert.equal(c.inside, 1);
  assert.equal(c.outside, 1);
  assert.ok(Math.abs(c.totalDiff - (-0.1 - 0.8)) < 1e-9);
  assert.equal(c.largestSaving!.fixing, 3.4);
  assert.equal(c.largestCost, null);
  const empty = coverage([]);
  assert.equal(empty.meanAbsDiff, 0);
  const g = backtestGeometry(b.weeks, 800, 300);
  assert.equal(g.weeks.length, 2);
  assert.ok(g.weeks.every((w) => w.band.y0 < w.band.y1));
  assert.ok(backtestGeometry([], 375, 240).yTicks.every((t) => Number.isFinite(t.y)));
  assert.equal(niceStep(0.13), 0.2);
  assert.equal(niceStep(0), 1);
});

test("backtest: the columnar site.json the backtest package writes", () => {
  const b = readBacktest({ underlying: "H100", band_bps: 1500, weeks: ["2025-04-14", "2025-04-28"], anchor: [2.97, 2.97], fixing: [2.97, 3.5], floor: [2.525, 2.525], cap: [3.415, 3.415], hedged: [2.97, 3.0], unhedged: [2.97, 3.5], inside: [true, false] }, null)!;
  assert.equal(b.weeks.length, 2);
  assert.equal(b.weeks[1]!.inside, false);
  assert.equal(b.weeks[0]!.anchor, 2.97);
  assert.equal(b.meta.underlying, "H100");
  assert.equal(b.meta.anchor, undefined);
  assert.equal(b.weeks[0]!.start, Date.UTC(2025, 3, 14) / 1000);
});

test("backtest caveats come from summary.md, and nothing when it is absent", () => {
  const md = "# T\n\n## What this does not show\n\n- **No real order flow.** Nobody traded `these`.\n- **Gaps.** Days.\n\n## Next\n- **x.** y";
  assert.deepEqual(caveatsFromMarkdown(md), [{ title: "No real order flow", text: "Nobody traded these." }, { title: "Gaps", text: "Days." }]);
  assert.deepEqual(caveatsFromMarkdown(null), []);
  assert.deepEqual(caveatsFromMarkdown("# none"), []);
});
