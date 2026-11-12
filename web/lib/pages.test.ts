// The loaders behind the static pages, on the model: what the build writes and what the browser
// reads again. The smoke test sees only the static HTML; these see what the browser would show
// for a range, a past round, the agents on the book and the proof page's live parts.
import assert from "node:assert/strict";
import test from "node:test";

process.env.WEIR_MODEL = "1";
const { MARKET_IDS } = await import("./config.ts");
const { source, serverReader } = await import("./source.ts");
const { loadHome, homeKey, homeProbe, RANGES } = await import("./data/home.ts");
const { loadAuction, auctionKey, auctionProbe } = await import("./data/auction.ts");
const { loadAgents } = await import("./data/agents.ts");
const { loadProof } = await import("./data/proof.ts");
const { valueOf } = await import("./cache.ts");

test("home: every market and every range loads, and its fingerprint matches the probe", async () => {
  for (const m of MARKET_IDS) {
    for (const r of RANGES[m]) {
      const d = await loadHome(source(m), { range: r.id, bundlesBase: null, chipSources: MARKET_IDS.filter((x) => x !== m).map(source) });
      assert.equal(d.chart.range, r.id, `${m} ${r.id}`);
      assert.ok(valueOf(d.core.params), `${m}: params`);
      assert.ok((valueOf(d.chart.prints) ?? []).length > 0, `${m} ${r.id}: prints`);
      assert.equal(d.chips.length, MARKET_IDS.length - 1);
      assert.ok(d.chips.every((c) => c.last !== null && c.tick !== null), `${m}: chip cards`);
    }
    const d = await loadHome(source(m), { range: null, bundlesBase: null, chipSources: [] });
    assert.equal(d.chart.range, RANGES[m][1]!.id, `${m}: default range`);
    assert.equal(await homeProbe(source(m)), homeKey(d), `${m}: probe`);
  }
});

test("auction: the round in progress, and a past round asked for by link, with its fills", async () => {
  for (const m of MARKET_IDS) {
    const live = await loadAuction(source(m), null);
    assert.ok(live.live, `${m}: a live series`);
    assert.equal(await auctionProbe(source(m), null), auctionKey(live), `${m}: probe`);
    const recent = valueOf(live.recent!) ?? [];
    const traded = [...recent].reverse().find(([, r]) => r.price !== null);
    assert.ok(traded, `${m}: a cleared round with a price`);
    const sel = { series: live.live!.series, round: traded![0] };
    const past = await loadAuction(source(m), sel);
    assert.deepEqual(past.sel, sel);
    const result = valueOf(past.result!);
    assert.ok(result && result.price !== null && result.fills.length > 0, `${m}: result with fills`);
  }
});

test("agents: entries come only from accounts with function-call keys", async () => {
  const { MODEL_AGENTS } = await import("./model.ts");
  const fc = new Set(MODEL_AGENTS.filter((a) => a.functionCallOnly).map((a) => a.id));
  let seen = 0;
  for (const m of MARKET_IDS) {
    const d = await loadAgents(serverReader(m));
    assert.ok(d.list.length <= 20);
    assert.equal(d.unknown, 0);
    assert.ok(d.list.every((e) => fc.has(e.owner)), `${m}: an owner with a full-access key`);
    seen += d.list.length;
  }
  // Which rounds hold the scripted agents depends on the clock; across four markets some do.
  assert.ok(seen > 0);
});

test("proof: totals, the token balance and the last prints are read for the market shown", async () => {
  for (const m of MARKET_IDS) {
    const d = await loadProof([{ market: m, account: `${m}.weir.model`, role: "Weir contract (model)", kind: "model" }], serverReader, m);
    assert.equal(d.kind, "model");
    assert.ok(d.params && valueOf(d.params));
    assert.ok(d.totals && valueOf(d.totals));
    assert.ok(d.balance && /^\d+$/.test(valueOf(d.balance) ?? ""));
    assert.ok(d.prints.length > 0 && d.prints.length <= 5);
    assert.equal(d.contracts[0]!.keys, null, "model rows are not read");
  }
});
