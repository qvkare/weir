import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKETS } from "@weir/agents/sim";
import { MARKET_IDS } from "./config.ts";
import { modelIndex, modelMarket, modelView } from "./model.ts";
import { totalsSum } from "./views.ts";

const now = 1_794_425_951;

test("the model is deterministic: the same clock gives the same views", () => {
  const a = modelView("h100-fast", "get_status", {}, now);
  const b = modelView("h100-fast", "get_status", {}, now);
  assert.deepEqual(a, b);
  assert.equal(modelIndex("h100-weekly", 3600), modelIndex("h100-weekly", 3600));
});

test("the four model markets have a live series, prints and cleared rounds, and the money adds up", () => {
  for (const id of MARKET_IDS) {
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
    // Invariant 1: every deposited dollar is free, locked, backing sets, unredeemed or burned.
    assert.equal(totals, deposited, `${id} solvency`);
    assert.ok(BigInt(modelView(id, "get_totals", {}, now).burned) > 0n, `${id} burned commit fees`);
  }
});

test("a later clock advances the same state without restarting", () => {
  const st = modelMarket("h100-fast", now);
  const before = st.market.events.length;
  const later = modelMarket("h100-fast", now + 600);
  assert.equal(later, st);
  assert.ok(later.market.events.length > before);
});

test("the site's market ids are the agents package's MARKETS, with the same chips", () => {
  assert.deepEqual([...MARKET_IDS].sort(), Object.keys(MARKETS).sort());
  for (const id of MARKET_IDS) assert.ok(modelIndex(id, 0) > 0);
});

test("a bucket can end with no print in the model, and its state says so", () => {
  const id = "h100-fast";
  const st = modelMarket(id, now);
  const I = st.market.params.printIntervalSecs;
  let noPrint = 0;
  let final = 0;
  for (let b = Math.floor((now - 400 * I) / I) * I; b < now - 2 * I; b += I) {
    const p = modelView(id, "get_print", { bucket: b }, now);
    if (p?.state === "NoPrint") noPrint++;
    if (p?.state === "Final") final++;
  }
  assert.ok(final > noPrint && noPrint > 0, `${final} final, ${noPrint} no print`);
});
