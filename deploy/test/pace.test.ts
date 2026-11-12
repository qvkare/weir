// The deploy tool's RPC policy (`src/pace.ts`, `rpcFor`): the chain client's failover and
// cooldowns, its rate-limit wait raised to 30 s, and a call that every endpoint refuses for rate
// retried until 120 s (60 s in verify) have passed; the final error names every endpoint. A fake
// clock: `sleep` advances it, nothing really waits. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcError, RpcUnavailable, type FetchLike } from "../../chain/src/mod.ts";
import { rpcFor } from "../src/chain.ts";
import { DEPLOY_MAX_CALL_WAIT_MS, spacedFetch } from "../src/pace.ts";

const ACCOUNT = { amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1 };
const ok = (result: unknown) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }), headers: { get: () => null } });
// fastnear's refusal over its free limit, measured 2026-11-12 (chain/README.md, "RPC endpoints").
const limited = (retryAfter: string | null = null) => ({
  status: 429,
  text: async () => JSON.stringify({ jsonrpc: "2.0", error: { code: -429, message: "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com" }, id: "1" }),
  headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter : null) },
});

function clock() {
  const c = { t: 1_000_000, waits: [] as number[] };
  return { c, now: () => c.t, sleep: async (ms: number) => void (c.waits.push(ms), (c.t += ms)) };
}
const URLS = ["https://first.example/", "https://second.example/"];
const host = (u: string) => new URL(u).host;

test("both endpoints rate-limited briefly, then recovering: the call gets its answer", async () => {
  const k = clock();
  const until = k.c.t + 25_000; // both refuse for 25 s
  const seen: string[] = [];
  const f: FetchLike = async (url) => (seen.push(host(url)), k.c.t < until ? limited() : ok(ACCOUNT));
  const rpc = rpcFor(URLS, f, { now: k.now, sleep: k.sleep, minGapMs: 0 });
  const a = await rpc.viewAccount("x.testnet");
  assert.equal(a.amount, "1");
  assert.ok(k.c.t - 1_000_000 >= 25_000 && k.c.t - 1_000_000 <= 40_000, `answered after ${k.c.t - 1_000_000} ms of waiting`);
  assert.ok(seen.includes("first.example") && seen.includes("second.example"));
});

test("both endpoints rate-limited beyond the bound: RpcUnavailable naming both and what they said", async () => {
  const k = clock();
  const f: FetchLike = async () => limited();
  const rpc = rpcFor(URLS, f, { now: k.now, sleep: k.sleep, minGapMs: 0 });
  const err = await rpc.viewAccount("x.testnet").then(() => null, (e: unknown) => e);
  assert.ok(err instanceof RpcUnavailable);
  assert.match(err.message, /^every RPC endpoint failed for query \(rate-limited on every endpoint; gave up after \d+ s of waiting, the bound is 120 s\): /);
  assert.match(err.message, /first\.example answered HTTP 429: Rate limits exceeded\. .* \(code -429\)/);
  assert.match(err.message, /second\.example answered HTTP 429: Rate limits exceeded/);
  const waited = k.c.t - 1_000_000;
  assert.ok(waited >= DEPLOY_MAX_CALL_WAIT_MS && waited <= DEPLOY_MAX_CALL_WAIT_MS + 30_000, `gave up after ${waited} ms`);
});

test("a retry-after longer than the client's own wait is still waited out, in 5 s pauses", async () => {
  const k = clock();
  const until = k.c.t + 45_000;
  const f: FetchLike = async () => (k.c.t < until ? limited("45") : ok(ACCOUNT));
  const rpc = rpcFor(URLS, f, { now: k.now, sleep: k.sleep, minGapMs: 0 });
  assert.equal((await rpc.viewAccount("x.testnet")).amount, "1");
  assert.ok(k.c.waits.includes(5_000), "paused while the client would not send");
});

test("a burst limit like fastnear's (5 answered, then 429) costs waits, not failures", async () => {
  // Measured 2026-11-12 on archival-rpc.testnet.fastnear.com: 5 x 200, then 429 with retry-after 0,
  // answered again within 5 s. Here the window refills 1 s after the first refusal.
  const k = clock();
  let budget = 5;
  let refilled = 0;
  const f: FetchLike = async (url) => {
    if (host(url) !== "first.example") return limited();
    if (budget === 0 && k.c.t >= refilled) budget = 5;
    if (budget === 0) return limited("0");
    if (--budget === 0) refilled = k.c.t + 1_000;
    return ok({ gas_price: "100000000" });
  };
  const rpc = rpcFor(URLS, f, { now: k.now, sleep: k.sleep, minGapMs: 0 });
  for (let i = 0; i < 30; i++) assert.equal((await rpc.call<{ gas_price: string }>("gas_price", [null])).gas_price, "100000000");
});

test("a node's answer is thrown at once, and an unreachable pair fails at once, both named", async () => {
  const k = clock();
  const answer: FetchLike = async () => ({
    status: 200,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, data: "does not exist" } }),
    headers: { get: () => null },
  });
  await assert.rejects(rpcFor(URLS, answer, { now: k.now, sleep: k.sleep, minGapMs: 0 }).viewAccount("x.testnet"), (e) => e instanceof RpcError && e.code === "UNKNOWN_ACCOUNT");
  const down: FetchLike = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  await assert.rejects(rpcFor(URLS, down, { now: k.now, sleep: k.sleep, minGapMs: 0 }).viewAccount("x.testnet"), /every RPC endpoint failed for query: first\.example: connect ECONNREFUSED; second\.example: connect ECONNREFUSED$/);
  assert.deepEqual(k.c.waits, [], "no waiting for anything but rate");
});

test("requests to one host are at least minGapMs apart; other hosts are not held up", async () => {
  const k = clock();
  const f = spacedFetch({ fetch: async () => ok({}), minGapMs: 100, now: k.now, sleep: k.sleep });
  const init = { method: "POST" as const, headers: {}, body: "{}", signal: new AbortController().signal };
  await f("https://a.example/", init);
  await f("https://a.example/", init);
  await f("https://b.example/", init);
  k.c.t += 30;
  await f("https://a.example/", init);
  assert.deepEqual(k.c.waits, [100, 70]);
});
