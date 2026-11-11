import assert from "node:assert/strict";
import { test } from "node:test";
import { modelIndex, modelMarket, modelView } from "./model.ts";
import { totalsSum } from "./views.ts";

const now = 1_794_425_951;

test("the model is deterministic: the same clock gives the same views", () => {
  const a = modelView("fast", "get_status", {}, now);
  const b = modelView("fast", "get_status", {}, now);
  assert.deepEqual(a, b);
  assert.equal(modelIndex("weekly", 3600), modelIndex("weekly", 3600));
});

test("both model markets have a live series, prints and cleared rounds, and stay solvent", () => {
  for (const id of ["weekly", "fast"] as const) {
    const st = modelMarket(id, now);
    const status = modelView(id, "get_status", {}, now);
    assert.ok(status.live.length >= 1, `${id} has a live series`);
    assert.ok(modelView(id, "get_last_print", {}, now), `${id} has a print`);
    const live = status.live[0]!;
    const results = modelView(id, "get_results", { series: live.series, from_round: 0, limit: 100 }, now);
    assert.ok(results.length > 0, `${id} has cleared rounds`);
    assert.ok(results.some(([, r]) => r.price !== null), `${id} has a round that traded`);
    const totals = totalsSum(modelView(id, "get_totals", {}, now))!;
    let deposited = 0n;
    for (const e of st.market.events) if (e.event === "deposit") deposited += e.data.amount;
    assert.ok(totals <= deposited, `${id} solvency`);
  }
});

test("a later clock advances the same state without restarting", () => {
  const st = modelMarket("fast", now);
  const before = st.market.events.length;
  const later = modelMarket("fast", now + 600);
  assert.equal(later, st);
  assert.ok(later.market.events.length > before);
});
