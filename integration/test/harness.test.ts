// Offline checks of the harness itself: the parity comparison reports what differs (and only
// that), and the gas table flags what it should. No sandbox needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelWeir, paramsFromWire, type NearRpc } from "../../chain/src/mod.ts";
import { eventLog, Market } from "../../engine/src/mod.ts";
import { PRESETS } from "../../agents/src/presets.ts";
import { gasTable } from "../src/gas.ts";
import { Twin, type ChainSide, type TwinLog } from "../src/twin.ts";

const params = { ...PRESETS.fast, usdc: "usdc.test", reporters: ["a.test", "b.test", "c.test"] };

function setup() {
  const model = new ModelWeir(new Market(paramsFromWire(params), 1000), "viewer.test");
  const log: TwinLog = { calls: [], diffs: [], views: [] };
  const twin = new Twin({ rpc: {} as NearRpc, contractId: "weir.test", usdcId: "usdc.test", model, log, scenario: "unit" });
  return { model, log, twin };
}

/** What the contract would have logged for a register, computed independently of the model. */
const registerLog = (id: string) => `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"register","data":{"account_id":"${id}"}}`;
const side = (x: Partial<ChainSide>): ChainSide => ({ ok: true, result: null, events: [], wall_ms: 0, exec_time: 1001, exec_height: 5, ...x });

test("a call the chain and the model agree on is recorded as the same", () => {
  const { twin, log, model } = setup();
  const r = twin.replay({ account: "alice.test", method: "register", args: {}, chain: side({ events: [registerLog("alice.test")] }) });
  assert.equal(r.same, true);
  assert.deepEqual(log.diffs, []);
  assert.equal(model.now(), 1001);
  assert.equal(eventLog(model.market.events[0]!), registerLog("alice.test"));
});

test("differing panic text, outcome, events and key order are each reported", () => {
  const { twin, log } = setup();
  twin.replay({ account: "alice.test", method: "register", args: {}, chain: side({ events: [registerLog("alice.test")] }) });
  // Same refusal, other words.
  twin.replay({ account: "alice.test", method: "register", args: {}, chain: side({ ok: false, error: "account is registered already" }) });
  // The chain succeeds where the model refuses.
  twin.replay({ account: "bob.test", method: "withdraw", args: { amount: "1" }, chain: side({ ok: true }) });
  // Same event, keys in another order.
  twin.replay({ account: "carol.test", method: "register", args: {}, chain: side({ events: [`EVENT_JSON:{"version":"1.0.0","standard":"weir","event":"register","data":{"account_id":"carol.test"}}`] }) });
  assert.deepEqual(log.diffs.map((d) => d.kind), ["error_text", "outcome", "events_key_order"]);
  assert.equal(log.diffs[0]!.model, "account is already registered");
  assert.match(twin.diverged ?? "", /withdraw/);
});

test("a call the node refused before execution is not made on the model", () => {
  const { twin, log, model } = setup();
  const r = twin.replay({ account: "agent.test", method: "withdraw", args: { amount: "1" }, chain: side({ ok: false, kind: "rpc", error: "INVALID_TRANSACTION", exec_time: undefined }) });
  assert.equal(r.model, null);
  assert.deepEqual(log.diffs, []);
  assert.equal(model.market.events.length, 0);
});

test("a chain time earlier than the model's clock is reported, not applied", () => {
  const { twin, log, model } = setup();
  model.setTime(2000);
  twin.replay({ account: "alice.test", method: "register", args: {}, chain: side({ exec_time: 1500, events: [registerLog("alice.test")] }) });
  assert.deepEqual(log.diffs.map((d) => d.kind), ["clock"]);
  assert.equal(model.now(), 2000);
});

test("the gas table flags margins under 2x and over 10x", () => {
  const call = (method: string, tgas: number) => ({
    n: 0, scenario: "unit", account: "a", method, args: {}, model: null, same: true,
    chain: side({ gas_burnt: tgas * 1e12, receipts: [{ executor: "weir.test", gas_burnt: tgas * 0.8e12 }] }),
  });
  const rows = gasTable([call("commit", 2), call("commit", 4), call("clear", 200), call("settle", 20)], [], () => null);
  const by = Object.fromEntries(rows.map((r) => [r.method, r]));
  assert.equal(by.commit!.max_tgas, 4);
  assert.equal(by.commit!.margin, 12.5);
  assert.equal(by.commit!.flag, "over 10x");
  assert.equal(by.clear!.flag, "margin under 2x");
  assert.equal(by.settle!.flag, "");
  assert.equal(by.commit!.proposed_tgas, 10);
  assert.equal(by.clear!.proposed_tgas, 300);
});
