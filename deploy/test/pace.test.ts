// The paced fetch behind `rpcFor`: a rate limit is waited out on the same endpoint (retry-after,
// else 1, 2, 4 s ...), and only a refusal that outlasts `maxWaitMs` reaches `NearRpc`, which then
// fails over. Requests to one host are spaced; each try has its own timeout. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchLike } from "../../chain/src/mod.ts";
import { rpcFor } from "../src/chain.ts";
import { pacedFetch } from "../src/pace.ts";

const reply = (status: number, body: unknown, retryAfter?: string) => ({
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
});
const req = (method = "query") => ({ method: "POST" as const, headers: {}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }), signal: new AbortController().signal });

test("a 429 with retry-after 0 is waited out with 1, 2, 4 s on the same endpoint", async () => {
  const answers = [429, 429, 429, 200];
  const urls: string[] = [];
  const waits: number[] = [];
  const f = pacedFetch({ fetch: async (url) => (urls.push(url), reply(answers.shift()!, { ok: 1 }, "0")), sleep: async (ms) => void waits.push(ms), minGapMs: 0 });
  const r = await f("https://a.example/", req());
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"ok":1}');
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.deepEqual(new Set(urls), new Set(["https://a.example/"]));
});

test("a positive retry-after is honoured, capped at 30 s", async () => {
  const answers = [reply(429, "", "3"), reply(503, "", "120"), reply(200, "{}")];
  const waits: number[] = [];
  const f = pacedFetch({ fetch: async () => answers.shift()!, sleep: async (ms) => void waits.push(ms), minGapMs: 0 });
  assert.equal((await f("https://a.example/", req())).status, 200);
  assert.deepEqual(waits, [3000, 30_000]);
});

test("a refusal that outlasts maxWaitMs is handed on, and NearRpc fails over to the next endpoint", async () => {
  const seen: string[] = [];
  const inner: FetchLike = async (url) => {
    seen.push(url);
    return url.includes("deprecated") ? reply(429, "THIS ENDPOINT IS DEPRECATED") : reply(200, { jsonrpc: "2.0", id: 1, result: { amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1 } });
  };
  const waits: number[] = [];
  const rpc = rpcFor(["https://deprecated.example/", "https://good.example/"], inner, { sleep: async (ms) => void waits.push(ms), maxWaitMs: 10_000, minGapMs: 0 });
  const a = await rpc.viewAccount("x.testnet");
  assert.equal(a.amount, "1");
  assert.deepEqual(waits, [1000, 2000, 4000], "1 + 2 + 4 = 7 s; the next wait (8 s) would pass 10 s");
  assert.equal(seen.filter((u) => u.includes("deprecated")).length, 4);
  assert.equal(seen.at(-1), "https://good.example/");
});

test("a burst limit like fastnear's (5 answered, then 429 for a while) costs waits, not failures", async () => {
  // Measured 2026-11-12 on archival-rpc.testnet.fastnear.com: 5 x 200, then 429 with retry-after 0.
  let budget = 5;
  let clock = 0;
  const inner: FetchLike = async () => {
    if (budget === 0) return reply(429, "", "0");
    budget--;
    return reply(200, { jsonrpc: "2.0", id: 1, result: { gas_price: "100000000" } });
  };
  const sleep = async (ms: number) => {
    clock += ms;
    budget = 5; // the window refills after any wait of a second or more
  };
  const seen = new Set<string>();
  const rpc = rpcFor(["https://first.example/", "https://second.example/"], async (url, init) => (seen.add(url), inner(url, init)), { sleep, now: () => clock, minGapMs: 0 });
  for (let i = 0; i < 30; i++) assert.equal((await rpc.call<{ gas_price: string }>("gas_price", [null])).gas_price, "100000000");
  assert.deepEqual([...seen], ["https://first.example/"], "never failed over");
  assert.equal(clock, 5 * 1000, "one 1 s wait per refusal, 5 refusals in 30 calls");
});

test("requests to one host are spaced by minGapMs; other hosts are not held up", async () => {
  let clock = 0;
  const waits: number[] = [];
  const f = pacedFetch({ fetch: async () => reply(200, "{}"), sleep: async (ms) => void (waits.push(ms), (clock += ms)), now: () => clock, minGapMs: 100 });
  await f("https://a.example/", req());
  await f("https://a.example/", req());
  await f("https://b.example/", req());
  clock += 30;
  await f("https://a.example/", req());
  assert.deepEqual(waits, [100, 70]);
});

test("each try has its own timeout, longer for calls that wait on the chain, in the words NearRpc knows", async () => {
  const hang: FetchLike = (_url, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const f = pacedFetch({ fetch: hang, timeoutMs: 20, longTimeoutMs: 40, minGapMs: 0 });
  await assert.rejects(f("https://a.example/", req("query")), /^Error: https:\/\/a\.example\/ timed out after 20 ms$/);
  await assert.rejects(f("https://a.example/", req("send_tx")), /timed out after 40 ms/);
  await assert.rejects(f("https://a.example/", req("tx")), /timed out after 40 ms/);
});
