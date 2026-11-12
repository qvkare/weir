// What the client does when an RPC provider refuses, in the shapes testnet providers really
// used on 2026-11-12 (chain/README.md, "RPC endpoints"): which errors are an endpoint failing
// and which are the node's answer, cooldowns, rate-limit waits, and sending a transaction
// whose first attempt may already have landed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EndpointError, EndpointHealth, NearRpc, RpcError, RpcUnavailable, TxStatusUnknown, type FetchLike } from "../src/near.ts";
import { base64Encode, utf8Encode } from "../src/tx.ts";

const FAST = "https://test.rpc.fastnear.com";
const DRPC = "https://near-testnet.drpc.org";

// Bodies exactly as the providers sent them.
const FASTNEAR_429 =
  '{"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com"}, "id": "1"}';
const DRPC_400 = '{"id":2,"jsonrpc":"2.0","error":{"message":"method is not available","code":-32601}}';
const FASTNEAR_PARSE_400 =
  '{"jsonrpc":"2.0","error":{"name":"REQUEST_VALIDATION_ERROR","cause":{"name":"PARSE_ERROR","info":{"error_message":"Failed parsing args: the value could not decoded from borsh due to: Unexpected length of input"}},"code":-32700,"message":"Parse error","data":"Failed parsing args: the value could not decoded from borsh due to: Unexpected length of input"},"id":3}';
const UNKNOWN_TX =
  '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"requested_transaction_hash":"H"},"name":"UNKNOWN_TRANSACTION"},"code":-32000,"message":"Server error","data":"Transaction H doesn\'t exist"},"id":1}';
const INVALID_NONCE =
  '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"name":"INVALID_TRANSACTION","info":{}},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidNonce":{"tx_nonce":7,"ak_nonce":7}}}}},"id":1}';

const ok = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });
const OUTCOME = ok({
  status: { SuccessValue: base64Encode(utf8Encode("3")) },
  transaction: { hash: "H" },
  transaction_outcome: { outcome: { logs: [], gas_burnt: 1 } },
  receipts_outcome: [],
});

type Reply = { status: number; body: string; retryAfter?: string } | "network" | "hang";

/** A fake fetch answering from a script per (host, JSON-RPC method), recording every request. */
function scripted(script: (url: string, method: string, n: number) => Reply) {
  const log: string[] = [];
  const counts = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    const { method } = JSON.parse(init.body) as { method: string };
    const key = `${new URL(url).host} ${method}`;
    log.push(key);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const reply = script(url, method, n);
    if (reply === "network") throw new TypeError("fetch failed");
    if (reply === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return {
      status: reply.status,
      text: async () => reply.body,
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (reply.retryAfter ?? null) : null) },
    };
  };
  return { fetch, log };
}

/** A clock the test moves, and a sleep that moves it. */
function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    sleeps,
  };
}

test("fastnear's 429 body: failed over to dRPC, fastnear cooled down, then used again after the cooldown", async () => {
  let limited = true;
  const { fetch, log } = scripted((url) => (url === FAST && limited ? { status: 429, body: FASTNEAR_429 } : { status: 200, body: ok(7) }));
  const c = clock();
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep });
  assert.equal(await rpc.call("block", {}), 7);
  assert.deepEqual(log, ["test.rpc.fastnear.com block", "near-testnet.drpc.org block"]);
  // Within the cooldown the next calls go straight to dRPC: no refused request paid.
  await rpc.call("block", {});
  await rpc.call("block", {});
  assert.deepEqual(log.slice(2), ["near-testnet.drpc.org block", "near-testnet.drpc.org block"]);
  // After it (10 s by default), fastnear, first in the list, is tried again.
  limited = false;
  c.advance(10_001);
  await rpc.call("block", {});
  assert.equal(log.at(-1), "test.rpc.fastnear.com block");
  assert.deepEqual(c.sleeps, [], "nothing waited: another endpoint answered");
});

test("the error text says what each endpoint said, never null", async () => {
  const { fetch } = scripted((url) => (url === FAST ? { status: 429, body: FASTNEAR_429 } : { status: 400, body: DRPC_400 }));
  const c = clock();
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep });
  const err = await rpc.call("broadcast_tx_commit", {}).then(
    () => assert.fail("should fail"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof RpcUnavailable);
  assert.equal(
    err.message,
    "every RPC endpoint failed for broadcast_tx_commit: " +
      "test.rpc.fastnear.com answered HTTP 429: Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com (code -429); " +
      "near-testnet.drpc.org answered HTTP 400: method is not available (code -32601)",
  );
  assert.doesNotMatch(err.message, /null/);
  assert.deepEqual(err.attempts.map((a) => [a.status, a.rateLimited, a.maybeDelivered]), [[429, true, false], [400, false, false]]);
});

test("dRPC's 400 body is that endpoint failing: the next endpoint answers", async () => {
  const { fetch, log } = scripted((url) => (url === DRPC ? { status: 400, body: DRPC_400 } : { status: 200, body: ok("from fastnear") }));
  const rpc = new NearRpc({ urls: [DRPC, FAST], fetch });
  assert.equal(await rpc.call("query", {}), "from fastnear");
  assert.deepEqual(log, ["near-testnet.drpc.org query", "test.rpc.fastnear.com query"]);
});

test("a 200 whose error is not in NEAR's shape, or that has no result, is the endpoint failing", async () => {
  const bodies = ['{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"upstream unavailable"}}', '{"jsonrpc":"2.0","id":1}', "<html>gateway</html>"];
  for (const bad of bodies) {
    const { fetch, log } = scripted((url) => (url === FAST ? { status: 200, body: bad } : { status: 200, body: ok(1) }));
    const rpc = new NearRpc({ urls: [FAST, DRPC], fetch });
    assert.equal(await rpc.call("query", {}), 1, bad);
    assert.equal(log.length, 2, bad);
  }
  const only = new NearRpc({ urls: [FAST], fetch: scripted(() => ({ status: 200, body: bodies[0]! })).fetch });
  await assert.rejects(only.call("query", {}), /test\.rpc\.fastnear\.com answered HTTP 200: upstream unavailable \(code -32603\)/);
});

test("a NEAR-shaped error is the node's answer even on HTTP 400: thrown at once, not tried elsewhere", async () => {
  const { fetch, log } = scripted(() => ({ status: 400, body: FASTNEAR_PARSE_400 }));
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch });
  await assert.rejects(rpc.call("send_tx", {}), (e: unknown) => e instanceof RpcError && e.code === "PARSE_ERROR" && /Failed parsing args/.test(e.message));
  assert.deepEqual(log, ["test.rpc.fastnear.com send_tx"]);
});

test("both endpoints rate-limited: one bounded wait (retry-after when it is short), one more try", async () => {
  let refusals = 2;
  const { fetch, log } = scripted(() => (refusals-- > 0 ? { status: 429, body: FASTNEAR_429, retryAfter: "1" } : { status: 200, body: ok("late") }));
  const c = clock();
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep });
  assert.equal(await rpc.call("query", {}), "late");
  assert.deepEqual(c.sleeps, [1000], "waited the 1 s retry-after once");
  assert.equal(log.length, 3);
});

test("both endpoints rate-limited for longer than the bound: no wait, and later calls fail without a request", async () => {
  const { fetch, log } = scripted(() => ({ status: 429, body: FASTNEAR_429, retryAfter: "30" }));
  const c = clock();
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep });
  await assert.rejects(rpc.call("query", {}), RpcUnavailable);
  assert.deepEqual(c.sleeps, []);
  assert.equal(log.length, 2);
  await assert.rejects(rpc.call("query", {}), /every endpoint is cooling down after refusals for 30 s more/);
  assert.equal(log.length, 2, "no request was paid for");
  // A 429 without retry-after cools for the default 10 s and is waited for when it is nearly over.
  c.advance(29_000);
  await assert.rejects(rpc.call("query", {}), RpcUnavailable);
  assert.deepEqual(c.sleeps, [1000], "waited the last second of the cooldown, once");
  assert.equal(log.length, 4, "then tried both once, without a second wait");
});

test("send_tx: the first endpoint times out, the same signed bytes go to the next without waiting, one outcome", async () => {
  const bodies: string[] = [];
  const base = scripted((url, method) => (url === FAST && method === "send_tx" ? "hang" : { status: 200, body: OUTCOME }));
  const fetch: FetchLike = (url, init) => (bodies.push(init.body), base.fetch(url, init));
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, sendTimeoutMs: 20 });
  const out = await rpc.sendTx(new Uint8Array([1, 2, 3]), "H", "a.testnet");
  assert.equal(out.result, 3);
  assert.deepEqual(base.log, ["test.rpc.fastnear.com send_tx", "near-testnet.drpc.org send_tx"]);
  const params = bodies.map((b) => (JSON.parse(b) as { params: { signed_tx_base64: string; wait_until: string } }).params);
  assert.equal(params[0]!.signed_tx_base64, params[1]!.signed_tx_base64, "the same signed bytes both times");
  assert.deepEqual(params.map((p) => p.wait_until), ["FINAL", "NONE"]);
});

test("send_tx: every endpoint fails after maybe delivering (502, timeout): polled by hash, one outcome", async () => {
  const sent: string[] = [];
  const { fetch } = scripted((url, method, n) => {
    if (method === "send_tx") {
      sent.push(new URL(url).host);
      return url === FAST ? { status: 502, body: "Bad Gateway" } : { status: 200, body: '{"jsonrpc":"2.0","id":1,"error":{"name":"HANDLER_ERROR","cause":{"name":"TIMEOUT_ERROR"},"data":"Timeout"}}' };
    }
    return n === 1 && url === FAST ? { status: 200, body: UNKNOWN_TX.replace("UNKNOWN_TRANSACTION", "TIMEOUT_ERROR") } : { status: 200, body: OUTCOME };
  });
  const c = clock();
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep });
  const out = await rpc.sendTx(new Uint8Array([1]), "H", "a.testnet");
  assert.equal(out.ok, true);
  assert.equal(out.result, 3);
  assert.deepEqual(sent, ["test.rpc.fastnear.com", "near-testnet.drpc.org"], "sent once to each endpoint, never re-signed");
});

test("send_tx: nobody knows the hash after a maybe-delivered failure: the same bytes are resent once, then found", async () => {
  let sends = 0;
  const { fetch } = scripted((_url, method) => {
    if (method === "send_tx") return ++sends === 1 ? "network" : { status: 200, body: ok({ final_execution_status: "NONE" }) };
    return { status: 200, body: sends >= 2 ? OUTCOME : UNKNOWN_TX };
  });
  const c = clock();
  const out = await new NearRpc({ urls: [FAST], fetch, now: c.now, sleep: c.sleep }).sendTx(new Uint8Array([1]), "H", "a.testnet");
  assert.equal(out.result, 3);
  assert.equal(sends, 2, "one resend after two lookups found nothing");
});

test("send_tx: InvalidNonce after another endpoint may have delivered it is our own transaction, landed", async () => {
  const { fetch, log } = scripted((url, method) => {
    if (method === "send_tx") return url === FAST ? { status: 504, body: "Gateway Timeout" } : { status: 200, body: INVALID_NONCE };
    return { status: 200, body: OUTCOME };
  });
  const c = clock();
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep });
  const out = await rpc.sendTx(new Uint8Array([1]), "H", "a.testnet");
  assert.equal(out.ok, true);
  assert.ok(log.includes("near-testnet.drpc.org tx") || log.includes("test.rpc.fastnear.com tx"));
});

test("send_tx: InvalidNonce when nothing was delivered, or the hash is unknown, is a real refusal", async () => {
  // Straight refusal: thrown at once, for NearAccount to re-sign with a fresh nonce.
  const straight = scripted((_url, method) => (method === "send_tx" ? { status: 200, body: INVALID_NONCE } : { status: 200, body: OUTCOME }));
  await assert.rejects(new NearRpc({ urls: [FAST, DRPC], fetch: straight.fetch }).sendTx(new Uint8Array([1]), "H", "a.testnet"), /InvalidNonce/);
  assert.deepEqual(straight.log, ["test.rpc.fastnear.com send_tx"]);
  // After a possible delivery, but no endpoint knows the hash: the nonce went to another transaction.
  const unknown = scripted((url, method) => {
    if (method === "send_tx") return url === FAST ? { status: 503, body: "" } : { status: 200, body: INVALID_NONCE };
    return { status: 200, body: UNKNOWN_TX };
  });
  const c = clock();
  await assert.rejects(new NearRpc({ urls: [FAST, DRPC], fetch: unknown.fetch, now: c.now, sleep: c.sleep }).sendTx(new Uint8Array([1]), "H", "a.testnet"), /InvalidNonce/);
});

test("send_tx: an 'already known' answer is pending, not a failure: polled to its outcome", async () => {
  const known = '{"jsonrpc":"2.0","id":1,"error":{"name":"HANDLER_ERROR","cause":{"name":"INVALID_TRANSACTION"},"data":"transaction already known"}}';
  const { fetch } = scripted((_url, method) => (method === "send_tx" ? { status: 200, body: known } : { status: 200, body: OUTCOME }));
  const c = clock();
  const out = await new NearRpc({ urls: [FAST], fetch, now: c.now, sleep: c.sleep }).sendTx(new Uint8Array([1]), "H", "a.testnet");
  assert.equal(out.result, 3);
});

test("send_tx refused for rate everywhere is not delivered: thrown, nothing polled", async () => {
  const { fetch, log } = scripted(() => ({ status: 429, body: FASTNEAR_429, retryAfter: "30" }));
  const c = clock();
  const err = await new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep }).sendTx(new Uint8Array([1]), "H", "a.testnet").catch((e: unknown) => e);
  assert.ok(err instanceof RpcUnavailable);
  assert.ok(err.attempts.every((a: EndpointError) => a.rateLimited && !a.maybeDelivered));
  assert.deepEqual(log, ["test.rpc.fastnear.com send_tx", "near-testnet.drpc.org send_tx"]);
});

test("clients sharing one EndpointHealth share a cooldown: the second never pays for fastnear's refusal", async () => {
  const { fetch, log } = scripted((url) => (url === FAST ? { status: 429, body: FASTNEAR_429 } : { status: 200, body: ok(1) }));
  const c = clock();
  const health = new EndpointHealth();
  const first = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep, health });
  const second = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep, health });
  await first.call("query", {});
  await second.call("query", {});
  assert.deepEqual(log, ["test.rpc.fastnear.com query", "near-testnet.drpc.org query", "near-testnet.drpc.org query"]);
});

// dRPC's free plan, 2026-11-12 19:00 UTC, as the keeper logged it.
const DRPC_408 = '{"jsonrpc":"2.0","id":1,"error":{"message":"Request timeout on the free plan, please upgrade to paid plan","code":30}}';
const PENDING = ok({ final_execution_status: "INCLUDED" });
const FINAL_OUTCOME = ok({
  final_execution_status: "FINAL",
  status: { SuccessValue: base64Encode(utf8Encode("true")) },
  transaction: { hash: "H" },
  transaction_outcome: { outcome: { logs: [], gas_burnt: 1 } },
  receipts_outcome: [{ outcome: { logs: ["EVENT_JSON:{}"], gas_burnt: 2 } }],
});

test("the 19:00 case: fastnear 429 and dRPC 408 on send_tx, then found by tx: one success, five requests", async () => {
  let lookups = 0;
  const { fetch, log } = scripted((url, method) => {
    if (method === "send_tx") return url === FAST ? { status: 429, body: FASTNEAR_429 } : { status: 408, body: DRPC_408 };
    return ++lookups === 1 ? { status: 200, body: PENDING } : { status: 200, body: FINAL_OUTCOME };
  });
  const c = clock();
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep });
  const out = await rpc.sendTx(new Uint8Array([9]), "H", "keeper.testnet");
  assert.deepEqual([out.ok, out.result, out.logs], [true, true, ["EVENT_JSON:{}"]]);
  // fastnear refused (cooling), dRPC timed out (not cooling): the lookups go to dRPC.
  assert.deepEqual(log, ["test.rpc.fastnear.com send_tx", "near-testnet.drpc.org send_tx", "near-testnet.drpc.org tx", "near-testnet.drpc.org tx"]);
  assert.deepEqual(c.sleeps, [1000, 1000]);
});

test("the 19:00 case with the transaction unknown everywhere: resent once with the same bytes, then reported unknown, not failed", async () => {
  const sentBytes: string[] = [];
  const base = scripted((url, method) => {
    if (method === "send_tx") return url === FAST ? { status: 429, body: FASTNEAR_429 } : { status: 408, body: DRPC_408 };
    return { status: 200, body: UNKNOWN_TX };
  });
  const fetch: FetchLike = (url, init) => {
    const body = JSON.parse(init.body) as { method: string; params: { signed_tx_base64?: string } };
    if (body.method === "send_tx") sentBytes.push(body.params.signed_tx_base64!);
    return base.fetch(url, init);
  };
  const c = clock();
  const err = await new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep })
    .sendTx(new Uint8Array([9]), "H", "keeper.testnet")
    .catch((e: unknown) => e);
  assert.ok(err instanceof TxStatusUnknown, String(err));
  assert.match(err.message, /outcome not known after 8 lookups, it may still land/);
  assert.ok(sentBytes.length >= 3 && new Set(sentBytes).size === 1, "only ever the same signed bytes");
  assert.equal(base.log.filter((l) => l.endsWith(" tx")).length, 8);
});

test("a 408 on a view fails over and puts nothing on cooldown: the next call tries dRPC first again", async () => {
  const { fetch, log } = scripted((url) => (url === DRPC ? { status: 408, body: DRPC_408 } : { status: 200, body: ok(1) }));
  const c = clock();
  const rpc = new NearRpc({ urls: [DRPC, FAST], fetch, now: c.now, sleep: c.sleep });
  assert.equal(await rpc.call("query", {}), 1);
  assert.equal(await rpc.call("query", {}), 1);
  assert.deepEqual(log, ["near-testnet.drpc.org query", "test.rpc.fastnear.com query", "near-testnet.drpc.org query", "test.rpc.fastnear.com query"]);
  const only = new NearRpc({ urls: [DRPC], fetch, now: c.now, sleep: c.sleep });
  await assert.rejects(only.call("query", {}), /near-testnet\.drpc\.org answered HTTP 408: Request timeout on the free plan, please upgrade to paid plan \(code 30\)/);
});

test("every error a fetch throws, of any class, is the endpoint failing: plain Error, TypeError, abort error", async () => {
  const thrown = [new Error("Network connection lost."), new TypeError("fetch failed"), Object.assign(new Error("The operation was aborted"), { name: "AbortError" })];
  for (const first of thrown) {
    const base = scripted(() => ({ status: 200, body: ok(1) }));
    const fetch: FetchLike = (url, init) => (url === FAST ? Promise.reject(first) : base.fetch(url, init));
    const rpc = new NearRpc({ urls: [FAST, DRPC], fetch });
    assert.equal(await rpc.call("query", {}), 1, first.message);
    assert.deepEqual(base.log, ["near-testnet.drpc.org query"], first.message);
  }
  const only = new NearRpc({ urls: [FAST, DRPC], fetch: async (url) => Promise.reject(new Error(`${new URL(url).host} unreachable`)) });
  await assert.rejects(only.call("query", {}), /every RPC endpoint failed for query: test\.rpc\.fastnear\.com: test\.rpc\.fastnear\.com unreachable; near-testnet\.drpc\.org: /);
});

test("an error isCallerError accepts goes up unchanged before a send, and as unknown once a send may have landed", async () => {
  class OutOfBudget extends Error {}
  let left = 0;
  const base = scripted((url, method) => (method === "send_tx" ? (url === FAST ? { status: 429, body: FASTNEAR_429 } : { status: 408, body: DRPC_408 }) : { status: 200, body: PENDING }));
  const fetch: FetchLike = (url, init) => {
    if (left-- <= 0) throw new OutOfBudget("no requests left");
    return base.fetch(url, init);
  };
  const c = clock();
  const isCallerError = (e: unknown) => e instanceof OutOfBudget;
  // Before anything was sent: the error itself, no failover, no cooldown.
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep, isCallerError });
  await assert.rejects(rpc.call("query", {}), OutOfBudget);
  assert.equal(base.log.length, 0);
  left = 1;
  assert.deepEqual(await rpc.call("tx", {}), { final_execution_status: "INCLUDED" }, "fastnear was not put on cooldown");
  assert.deepEqual(base.log, ["test.rpc.fastnear.com tx"]);
  // After dRPC may have delivered the transaction: unknown, not failed.
  left = 3;
  const err = await new NearRpc({ urls: [FAST, DRPC], fetch, now: c.now, sleep: c.sleep, isCallerError })
    .sendTx(new Uint8Array([9]), "H", "k.testnet")
    .catch((e: unknown) => e);
  assert.ok(err instanceof TxStatusUnknown);
  assert.match(err.message, /no requests left/);
  // Without the option the same error is just the endpoint failing.
  left = 0;
  await assert.rejects(new NearRpc({ urls: [FAST, DRPC], fetch }).call("query", {}), RpcUnavailable);
});
