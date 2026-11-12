// What the client does when an RPC provider refuses, in the shapes testnet providers really
// used on 2026-11-12 (chain/README.md, "RPC endpoints"): which errors are an endpoint failing
// and which are the node's answer, cooldowns, rate-limit waits, and sending a transaction
// whose first attempt may already have landed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EndpointError, EndpointHealth, NearRpc, RpcError, RpcUnavailable, type FetchLike } from "../src/near.ts";
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

test("send_tx: the first endpoint times out, the same signed bytes go to the next, one outcome", async () => {
  const bodies: string[] = [];
  const base = scripted((url, method) => (url === FAST && method === "send_tx" ? "hang" : { status: 200, body: OUTCOME }));
  const fetch: FetchLike = (url, init) => (bodies.push(init.body), base.fetch(url, init));
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch, sendTimeoutMs: 20 });
  const out = await rpc.sendTx(new Uint8Array([1, 2, 3]), "H", "a.testnet");
  assert.equal(out.result, 3);
  assert.deepEqual(base.log, ["test.rpc.fastnear.com send_tx", "near-testnet.drpc.org send_tx"]);
  const params = bodies.map((b) => (JSON.parse(b) as { params: unknown }).params);
  assert.deepEqual(params[0], params[1], "the same signed bytes both times");
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

test("send_tx: nobody knows the hash after a maybe-delivered failure: the same bytes are resent once", async () => {
  let sends = 0;
  const { fetch } = scripted((_url, method) => {
    if (method === "send_tx") return ++sends === 1 ? "network" : { status: 200, body: OUTCOME };
    return { status: 200, body: UNKNOWN_TX };
  });
  const rpc = new NearRpc({ urls: [FAST], fetch });
  const out = await rpc.sendTx(new Uint8Array([1]), "H", "a.testnet");
  assert.equal(out.result, 3);
  assert.equal(sends, 2);
});

test("send_tx: InvalidNonce after another endpoint may have delivered it is our own transaction, landed", async () => {
  const { fetch, log } = scripted((url, method) => {
    if (method === "send_tx") return url === FAST ? { status: 504, body: "Gateway Timeout" } : { status: 200, body: INVALID_NONCE };
    return { status: 200, body: OUTCOME };
  });
  const rpc = new NearRpc({ urls: [FAST, DRPC], fetch });
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
  await assert.rejects(new NearRpc({ urls: [FAST, DRPC], fetch: unknown.fetch }).sendTx(new Uint8Array([1]), "H", "a.testnet"), /InvalidNonce/);
});

test("send_tx: an 'already known' answer is pending, not a failure: polled to its outcome", async () => {
  const known = '{"jsonrpc":"2.0","id":1,"error":{"name":"HANDLER_ERROR","cause":{"name":"INVALID_TRANSACTION"},"data":"transaction already known"}}';
  const { fetch } = scripted((_url, method) => (method === "send_tx" ? { status: 200, body: known } : { status: 200, body: OUTCOME }));
  const out = await new NearRpc({ urls: [FAST], fetch }).sendTx(new Uint8Array([1]), "H", "a.testnet");
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
