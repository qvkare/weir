// RPC endpoint health shared by every connection of the keeper: a refusal seen for one market
// or agent spares the others and the next tick, and every attempt is still charged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EndpointHealth } from "@weir/chain";
import { Budget } from "../src/budget.ts";
import { nearChain, type Fetch } from "../src/ports.ts";
import { handle } from "../src/routes.ts";
import { deploymentsFor, START, world } from "./harness.ts";

const FAST = "https://rpc-a.test";
const SLOW = "https://rpc-b.test";
const [M1, M2, M3] = deploymentsFor(["h100-fast", "h100-weekly", "h200-weekly"]).markets as [never, never, never];

/** fastnear's 429 body, as measured on 2026-11-12 (chain/README.md). */
const RATE_BODY = JSON.stringify({ jsonrpc: "2.0", error: { code: -429, message: "Rate limits exceeded." }, id: "1" });

/** An RPC that answers every view with `{}`; endpoints in `refusing` answer HTTP 429. */
function fakeRpc() {
  const calls: string[] = [];
  const refusing = new Set<string>();
  const fetch: Fetch = async (url, init) => {
    calls.push(new URL(url).host);
    const id = (JSON.parse(String(init?.body)) as { id: number }).id;
    if (refusing.has(url)) return new Response(RATE_BODY, { status: 429 });
    const bytes = [...new TextEncoder().encode("{}")];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { result: bytes, logs: [], block_height: 1, block_hash: "x" } }), { status: 200 });
  };
  return { calls, refusing, fetch };
}

/** One tick's view of the chain: a fresh budget, every request through its meter. */
function tickOf(rpc: ReturnType<typeof fakeRpc>) {
  const budget = new Budget(40);
  return { budget, hooks: { fetch: budget.meter(rpc.fetch), onOutcome: () => undefined } };
}

test("a 429 seen for one market spares every other connection, in the same tick and the next, and every attempt is charged", async () => {
  const rpc = fakeRpc();
  let clock = 1_000_000;
  const chain = nearChain([FAST, SLOW], { health: new EndpointHealth(), now: () => clock, sleep: async () => undefined });
  rpc.refusing.add(FAST);

  // Tick 1, market 1: the first endpoint refuses, the second answers. Two attempts, two charged.
  const t1 = tickOf(rpc);
  await (await chain.connect(M1, null, t1.hooks)).view("get_status" as never, {} as never);
  assert.deepEqual(rpc.calls, ["rpc-a.test", "rpc-b.test"]);
  assert.equal(t1.budget.used, 2);
  assert.deepEqual(chain.cooling!(), [{ endpoint: "rpc-a.test", until: Math.ceil((clock + 10_000) / 1000), rate: true }]);

  // Same tick, another market's port: straight to the second endpoint. One attempt, one charged.
  await (await chain.connect(M2, null, t1.hooks)).view("get_status" as never, {} as never);
  assert.deepEqual(rpc.calls.slice(2), ["rpc-b.test"]);
  assert.equal(t1.budget.used, 3);

  // Next tick, 5 s later: the cooldown still holds, so it is still passed over.
  clock += 5_000;
  const t2 = tickOf(rpc);
  await (await chain.connect(M3, null, t2.hooks)).view("get_status" as never, {} as never);
  assert.deepEqual(rpc.calls.slice(3), ["rpc-b.test"]);
  assert.equal(t2.budget.used, 1);

  // A minute later the cooldown is over: the first endpoint is first in line again.
  clock += 60_000;
  rpc.refusing.clear();
  assert.deepEqual(chain.cooling!(), []);
  const t3 = tickOf(rpc);
  await (await chain.connect(M1, null, t3.hooks)).view("get_status" as never, {} as never);
  assert.deepEqual(rpc.calls.slice(4), ["rpc-a.test"]);
  assert.equal(t3.budget.used, 1);
  assert.equal(t1.budget.used + t2.budget.used + t3.budget.used, rpc.calls.length, "every attempt charged, nothing else");
});

test("every endpoint refusing for longer than the client waits: the next call anywhere fails without a request and costs nothing", async () => {
  const rpc = fakeRpc();
  const clock = 2_000_000;
  const chain = nearChain([FAST, SLOW], { health: new EndpointHealth(), now: () => clock, sleep: async () => undefined });
  rpc.refusing.add(FAST).add(SLOW);
  const t = tickOf(rpc);
  // 429 without retry-after: a 10 s cooldown each; the client waits 1 s once and tries both again.
  await assert.rejects((await chain.connect(M1, null, t.hooks)).view("get_status" as never, {} as never), /every RPC endpoint failed/);
  const spent = t.budget.used;
  assert.equal(spent, rpc.calls.length);
  await assert.rejects((await chain.connect(M2, null, t.hooks)).view("get_status" as never, {} as never), /cooling down after refusals/);
  assert.equal(rpc.calls.length, spent, "no request");
  assert.equal(t.budget.used, spent, "nothing charged");
});

test("without options every nearChain of the process shares one EndpointHealth, as runTick's per-tick chains need", async () => {
  const rpc = fakeRpc();
  const urls = ["https://shared-a.test", "https://shared-b.test"];
  rpc.refusing.add(urls[0]!);
  const tick1 = nearChain(urls);
  await (await tick1.connect(M1, null, tickOf(rpc).hooks)).view("get_status" as never, {} as never);
  const tick2 = nearChain(urls);
  assert.deepEqual(tick2.cooling!().map((c) => [c.endpoint, c.rate]), [["shared-a.test", true]]);
  await (await tick2.connect(M1, null, tickOf(rpc).hooks)).view("get_status" as never, {} as never);
  assert.deepEqual(rpc.calls, ["shared-a.test", "shared-b.test", "shared-b.test"]);
});

test("cooldowns in force when a tick starts are logged, and those at its end are in /status", async () => {
  const w = world({ markets: ["h100-fast"] });
  const cooling = [{ endpoint: "rpc-a.test", until: START + 40, rate: true }];
  const report = await w.at(START, { chain: { ...w.chain, cooling: () => cooling } });
  assert.ok(report.entries.some((e) => e.action === "rpc" && e.text === `RPC endpoints passed over after earlier refusals: rpc-a.test until ${START + 40} (rate limit)`));
  assert.deepEqual(report.rpc_cooling, cooling);
  const s = (await (await handle(new Request("http://localhost/status"), w.store)).json()) as { rpc_cooling: unknown };
  assert.deepEqual(s.rpc_cooling, cooling);
});
