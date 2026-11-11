// The testnet faucet client against a fake helper service and a fake RPC: it waits through
// rate limits and outages and resumes, takes an account that already exists as created, and
// stops on a refusal. Nothing here reaches a network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58Encode, KeyPair, NearRpc, type FetchLike } from "../../chain/src/mod.ts";
import { faucetCreator, FAUCET_URL } from "../src/chain.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const outcome = (value: string) => ({
  status: { SuccessValue: b64(value) },
  transaction: { hash: "FaucetTx111111111111111111111111111111111111" },
  transaction_outcome: { outcome: { logs: [], gas_burnt: 1 } },
  receipts_outcome: [],
});

function world(exists: () => boolean) {
  const rpcFetch: FetchLike = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; params: { request_type: string } };
    const body = exists()
      ? { jsonrpc: "2.0", id: req.id, result: { amount: "10000000000000000000000000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182 } }
      : { jsonrpc: "2.0", id: req.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, data: "does not exist" } };
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  return new NearRpc({ urls: ["http://rpc.fake"], fetch: rpcFetch });
}

const key = () => KeyPair.fromString(`ed25519:${base58Encode(new Uint8Array(32).fill(9))}`);

test("waits through 429 and 503, then creates; the request is near-cli-rs's", async () => {
  let created = false;
  const calls: { url: string; body: unknown }[] = [];
  const answers = [new Response("slow down", { status: 429, headers: { "retry-after": "30" } }), new Response("oops", { status: 503 })];
  const waits: number[] = [];
  const create = faucetCreator({
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const a = answers.shift();
      if (a) return a;
      created = true;
      return new Response(JSON.stringify(outcome("true")), { status: 200 });
    },
    sleep: async (ms) => void waits.push(ms),
    log: () => {},
  });
  const k = await key();
  const r = await create(world(() => created), "weir-ops-x.testnet", k);
  assert.equal(r.hash, "FaucetTx111111111111111111111111111111111111");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, FAUCET_URL);
  assert.deepEqual(calls[0]!.body, { newAccountId: "weir-ops-x.testnet", newAccountPublicKey: k.publicKeyString });
  assert.deepEqual(waits, [30_000, 60_000], "honours retry-after, then doubles");
});

test("an account that already exists is not requested again", async () => {
  let n = 0;
  const create = faucetCreator({ fetch: async () => (n++, new Response("{}")), sleep: async () => {} });
  const r = await create(world(() => true), "weir-ops-x.testnet", await key());
  assert.equal(n, 0);
  assert.equal(r.hash, null);
});

test("a refusal or a 'false' stops at once; a long outage gives up with a resumable message", async () => {
  const refuse = faucetCreator({ fetch: async () => new Response("bad name", { status: 400 }), sleep: async () => {} });
  await assert.rejects(refuse(world(() => false), "x.testnet", await key()), /refused x\.testnet: HTTP 400: bad name/);
  const no = faucetCreator({ fetch: async () => new Response(JSON.stringify(outcome("false")), { status: 200 }), sleep: async () => {} });
  await assert.rejects(no(world(() => false), "x.testnet", await key()), /answered false/);
  const down = faucetCreator({ fetch: async () => new Response("", { status: 502 }), sleep: async () => {}, maxWaitMs: 100_000 });
  await assert.rejects(down(world(() => false), "x.testnet", await key()), /run apply again later and it resumes here/);
});
