import assert from "node:assert/strict";
import { test } from "node:test";
import { createSimulation } from "@weir/agents/sim";
import { snapshot } from "./sim-snapshot.ts";
import { settlementLine } from "./views.ts";

test("the void scenario: silent reporters make series 0 void, cancelled at the centre of the band", () => {
  const sim = createSimulation({ seed: 7, buyers: 3, sellers: 3, makers: 2, noise: 2, market: "h100-fast", silentSeries: 0 });
  sim.runRounds(10);
  sim.settleAll();
  const snap = snapshot(sim);
  const s0 = snap.settlements.find((s) => s.series === 0);
  assert.ok(s0, "series 0 settled");
  assert.equal(s0!.settlement.void, true);
  const line = settlementLine(s0!.settlement, snap.params.tick)!;
  assert.match(line, /^void: cancelled at the centre of the band, \$/);
  assert.ok(!line.includes("unwound"));
});
