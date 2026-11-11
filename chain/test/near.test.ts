// The RPC client against a fake transport: failover, timeouts, view decoding, outcome
// decoding, send_tx polling and nonces.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeOutcome, NearAccount, NearRpc, panicMessage, RpcError, type FetchLike } from "../src/near.ts";
import { base58Encode, base64Encode, KeyPair, utf8Encode } from "../src/tx.ts";
import { fakeNear } from "./fake_near.ts";

const ok = (result: unknown) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
const rpcErr = (error: unknown) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error }) });
const viewResult = (value: unknown) => ({ result: [...utf8Encode(JSON.stringify(value))], logs: [] });
const key = () => KeyPair.fromString(`ed25519:${base58Encode(new Uint8Array(32).fill(9))}`);

test("fails over to the next URL on network errors, HTTP 5xx and 429, and sticks with the one that answered", async () => {
  const seen: string[] = [];
  const fetch: FetchLike = async (url) => {
    seen.push(url);
    if (url === "a") throw new TypeError("fetch failed");
    if (url === "b") return { status: 503, text: async () => "busy" };
    if (url === "c") return { status: 429, text: async () => "slow down" };
    return ok(viewResult({ decimals: 6 }));
  };
  const rpc = new NearRpc({ urls: ["a", "b", "c", "d"], fetch });
  assert.deepEqual(await rpc.view("usdc", "ft_metadata"), { decimals: 6 });
  assert.deepEqual(seen, ["a", "b", "c", "d"]);
  await rpc.view("usdc", "ft_metadata");
  assert.deepEqual(seen.slice(4), ["d"]);
});

test("a URL that does not answer in time is abandoned for the next", async () => {
  const fetch: FetchLike = (url, init) =>
    url === "slow"
      ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
      : Promise.resolve(ok(viewResult(7)));
  const rpc = new NearRpc({ urls: ["slow", "fast"], timeoutMs: 30, fetch });
  assert.equal(await rpc.view("c", "m"), 7);
  const only = new NearRpc({ urls: ["slow"], timeoutMs: 30, fetch });
  await assert.rejects(only.view("c", "m"), /slow timed out after 30 ms/);
});

test("a JSON-RPC handler error is an answer: thrown at once, not retried", async () => {
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls++;
    return rpcErr({ name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "nobody.testnet does not exist" });
  };
  const rpc = new NearRpc({ urls: ["a", "b"], fetch });
  await assert.rejects(rpc.viewAccount("nobody.testnet"), (e: unknown) => e instanceof RpcError && e.code === "UNKNOWN_ACCOUNT");
  assert.equal(calls, 1);
});

test("view sends base64 JSON args at final finality and decodes the byte result", async () => {
  const fake = fakeNear();
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  assert.equal(await rpc.view("weir.testnet", "get_series", { series: 3 }), null);
  const { params } = fake.requests[0]!;
  assert.deepEqual(params, {
    request_type: "call_function",
    finality: "final",
    account_id: "weir.testnet",
    method_name: "get_series",
    args_base64: base64Encode(utf8Encode('{"series":3}')),
  });
});

test("a view whose contract panics rejects, in the old and the new error shapes", async () => {
  const old = new NearRpc({ urls: ["x"], fetch: async () => ok({ error: "wasm execution failed with error: index is stale", logs: [] }) });
  await assert.rejects(old.view("c", "m"), /index is stale/);
  const fresh = new NearRpc({
    urls: ["x"],
    fetch: async () => rpcErr({ name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR" }, data: "Smart contract panicked: no" }),
  });
  await assert.rejects(fresh.view("c", "m"), /Smart contract panicked: no/);
});

test("decodeOutcome: JSON result, empty result, non-JSON result, a panic, logs and gas from every receipt", () => {
  const base = {
    transaction: { hash: "H" },
    transaction_outcome: { outcome: { logs: ["a"], gas_burnt: 10 } },
    receipts_outcome: [{ outcome: { logs: ["b"], gas_burnt: 20 } }, { outcome: { logs: ["c"], gas_burnt: 30 } }],
  };
  const value = decodeOutcome({ ...base, status: { SuccessValue: base64Encode(utf8Encode("42")) } });
  assert.deepEqual(value, { ok: true, result: 42, logs: ["a", "b", "c"], error: null, tx_hash: "H", gas_burnt: 60 });
  assert.equal(decodeOutcome({ ...base, status: { SuccessValue: "" } }).result, null);
  assert.equal(decodeOutcome({ ...base, status: { SuccessValue: base64Encode(utf8Encode("plain")) } }).result, "plain");
  const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: round is full" } } } };
  const failed = decodeOutcome({ ...base, status: { Failure: failure } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "Smart contract panicked: round is full");
  assert.equal(panicMessage(failed.error!), "round is full");
  const other = decodeOutcome({ ...base, status: { Failure: { InvalidTxError: "Expired" } } });
  assert.equal(other.error, '{"InvalidTxError":"Expired"}');
});

test("NearAccount signs a function call, sends it with send_tx at FINAL and returns the decoded outcome", async () => {
  const fake = fakeNear();
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  const account = new NearAccount(rpc, "alice.testnet", await key());
  const out = await account.functionCall("weir.testnet", "clear", { series: 1, round: 2 }, 300_000_000_000_000n, 0n);
  assert.equal(out.ok, true);
  assert.equal(out.gas_burnt, 3_428_000_000_000);
  const send = fake.requests.find((r) => r.method === "send_tx")!;
  assert.equal(send.params.wait_until, "FINAL");
  assert.deepEqual(fake.sent, [
    { signer: "alice.testnet", receiver: "weir.testnet", method: "clear", args: { series: 1, round: 2 }, gas: 300_000_000_000_000n, deposit: 0n, nonce: 1n },
  ]);
});

test("concurrent calls from one account get increasing nonces; a stale nonce is read again once", async () => {
  const fake = fakeNear();
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  const k = await key();
  const account = new NearAccount(rpc, "bob.testnet", k);
  await Promise.all([1, 2, 3].map((n) => account.functionCall("c", "m", { n }, 1n, 0n)));
  assert.deepEqual(fake.sent.map((s) => [s.args.n, s.nonce]), [[1, 1n], [2, 2n], [3, 3n]]);
  // A second signer with the same key moves the chain nonce past ours: the first try fails with InvalidNonce.
  const other = new NearAccount(rpc, "bob.testnet", k);
  await other.functionCall("c", "m", { n: 4 }, 1n, 0n);
  let stale = true;
  fake.intercept = (_url, method) => {
    if (method === "query" && stale) {
      stale = false;
      return ok({ nonce: 0, permission: "FullAccess", block_hash: base58Encode(new Uint8Array(32)), block_height: 1 });
    }
    return undefined;
  };
  const fresh = new NearAccount(rpc, "bob.testnet", k);
  const out = await fresh.functionCall("c", "m", { n: 5 }, 1n, 0n);
  assert.equal(out.ok, true);
  assert.equal(fake.sent.at(-1)!.nonce, 5n);
});

test("InvalidNonce is retried with a fresh nonce up to three times, then the error is thrown", async () => {
  const fake = fakeNear();
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  const k = await key();
  let refusals = 2;
  let sends = 0;
  const invalid = rpcErr({ name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 1, ak_nonce: 1 } } } } });
  fake.intercept = (_url, method) => {
    if (method !== "send_tx") return undefined;
    sends++;
    return refusals-- > 0 ? invalid : undefined;
  };
  const out = await new NearAccount(rpc, "dave.testnet", k).functionCall("c", "m", {}, 1n, 0n);
  assert.equal(out.ok, true);
  assert.equal(sends, 3);
  // Refused every time: one try and three retries, then the refusal itself.
  refusals = Infinity;
  sends = 0;
  await assert.rejects(new NearAccount(rpc, "erin.testnet", k).functionCall("c", "m", {}, 1n, 0n), /InvalidNonce/);
  assert.equal(sends, 4);
});

test("when send_tx times out the client polls tx for the same hash", async () => {
  const fake = fakeNear();
  let txPolls = 0;
  fake.intercept = (_url, method, params) => {
    if (method === "send_tx") return rpcErr({ name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" }, data: "timeout" });
    if (method === "tx") {
      txPolls++;
      assert.equal(params.sender_account_id, "carol.testnet");
      if (txPolls < 2) return rpcErr({ name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" }, data: "still waiting" });
      return ok({
        status: { SuccessValue: base64Encode(utf8Encode("1")) },
        transaction: { hash: params.tx_hash },
        transaction_outcome: { outcome: { logs: [], gas_burnt: 1 } },
        receipts_outcome: [],
      });
    }
    return undefined;
  };
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  const account = new NearAccount(rpc, "carol.testnet", await key());
  const out = await account.functionCall("c", "m", {}, 1n, 0n);
  assert.equal(out.result, 1);
  assert.equal(txPolls, 2);
  assert.equal(fake.requests.filter((r) => r.method === "tx")[0]!.params.tx_hash, out.tx_hash);
});

test("latestBlockHash and viewAccessKey use final finality", async () => {
  const fake = fakeNear();
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  assert.equal(typeof (await rpc.latestBlockHash()), "string");
  const ak = await rpc.viewAccessKey("a.testnet", (await key()).publicKeyString);
  assert.equal(ak.permission, "FullAccess");
  assert.deepEqual(fake.requests.map((r) => r.params.finality), ["final", "final"]);
});
