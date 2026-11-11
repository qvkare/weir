// DeleteKey is the one action this package encodes itself; check it, and the whole
// transaction around it, byte for byte against @near-js (chain's dev dependency).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { base58Encode, encodeTransaction, KeyPair, signTransaction } from "../../chain/src/tx.ts";
import { encodeDeployTransaction, signDeployTransaction } from "../src/chain.ts";

const require = createRequire(new URL("../../chain/package.json", import.meta.url));
// Loaded from chain's dev dependencies; typed loosely, as only the bytes are compared.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nt = require("@near-js/transactions") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nc = require("@near-js/crypto") as any;

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

test("DeleteKey transactions match @near-js byte for byte", async () => {
  for (let i = 0; i < 100; i++) {
    const key = await KeyPair.fromString(`ed25519:${base58Encode(rand(32))}`);
    const pks = Array.from({ length: 1 + (i % 4) }, () => rand(32));
    const tx = { signerId: `weir-h100-fast-x${i}.testnet`, publicKey: key.publicKey, nonce: BigInt(i * 1000 + 7), receiverId: `weir-h100-fast-x${i}.testnet`, blockHash: rand(32), actions: pks.map((p) => ({ type: "DeleteKey" as const, publicKey: p })) };
    const ours = encodeDeployTransaction(tx);
    const theirs = nt.createTransaction(
      tx.signerId,
      new nc.PublicKey({ keyType: nc.KeyType.ED25519, data: tx.publicKey }),
      tx.receiverId,
      tx.nonce,
      pks.map((p) => nt.actionCreators.deleteKey(new nc.PublicKey({ keyType: nc.KeyType.ED25519, data: p }))),
      tx.blockHash,
    );
    assert.deepEqual(ours, Uint8Array.from(nt.encodeTransaction(theirs)));
    const { signed } = await signDeployTransaction(tx, key);
    assert.equal(signed.length, ours.length + 65);
  }
});

test("without DeleteKey, the encoding and signature are chain's own", async () => {
  const key = await KeyPair.fromString(`ed25519:${base58Encode(rand(32))}`);
  const tx = {
    signerId: "ops.test.near", publicKey: key.publicKey, nonce: 5n, receiverId: "a.ops.test.near", blockHash: rand(32),
    actions: [{ type: "CreateAccount" as const }, { type: "Transfer" as const, deposit: 10n ** 24n }, { type: "AddKey" as const, publicKey: rand(32), permission: { receiverId: "w.test.near", methodNames: ["report"], allowance: 5n } }, { methodName: "new", args: new Uint8Array([1, 2]), gas: 10n ** 14n, deposit: 0n }],
  };
  assert.deepEqual(encodeDeployTransaction(tx), encodeTransaction(tx));
  const a = await signDeployTransaction(tx, key);
  const b = await signTransaction(tx, key);
  assert.deepEqual(a.signed, b.signed);
  assert.equal(a.hash, base58Encode(b.hash));
});

test("a 400 kB contract deploy encodes (no argument-spreading limits) and matches @near-js", async () => {
  const key = await KeyPair.fromString(`ed25519:${base58Encode(rand(32))}`);
  const code = new Uint8Array(400_000).map((_, i) => i % 251);
  const del = rand(32);
  const tx = { signerId: "w.testnet", publicKey: key.publicKey, nonce: 9n, receiverId: "w.testnet", blockHash: rand(32), actions: [{ type: "DeployContract" as const, code }, { type: "DeleteKey" as const, publicKey: del }] };
  const theirs = nt.createTransaction(tx.signerId, new nc.PublicKey({ keyType: nc.KeyType.ED25519, data: tx.publicKey }), tx.receiverId, tx.nonce, [nt.actionCreators.deployContract(code), nt.actionCreators.deleteKey(new nc.PublicKey({ keyType: nc.KeyType.ED25519, data: del }))], tx.blockHash);
  assert.deepEqual(encodeDeployTransaction(tx), Uint8Array.from(nt.encodeTransaction(theirs)));
  const { signed } = await signDeployTransaction(tx, key);
  assert.ok(signed.length > 400_000);
});
