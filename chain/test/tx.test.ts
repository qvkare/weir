// Our borsh encoding and signatures against @near-js (an independent implementation) on
// random function-call transactions, plus the base58/base64 edge cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as ed from "@noble/ed25519";
import { KeyPair as NearJsKeyPair, PublicKey } from "@near-js/crypto";
import { actionCreators, createTransaction, decodeSignedTransaction, encodeTransaction as nearJsEncode, SignedTransaction, Signature } from "@near-js/transactions";
import { sha256 } from "@weir/engine";
import { base58Decode, base58Encode, base64Decode, base64Encode, encodeTransaction, KeyPair, signTransaction, type Transaction } from "../src/tx.ts";
import { bigUint, bytes, int, rng } from "./rng.ts";

const ACCOUNT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_.";
const METHOD_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_";
const word = (r: () => number, chars: string, lo: number, hi: number) =>
  Array.from({ length: int(r, lo, hi) }, () => chars[int(r, 0, chars.length - 1)]).join("");

test("base58 round-trips, keeps leading zeros and matches known values", () => {
  const r = rng(1);
  for (let i = 0; i < 500; i++) {
    const b = bytes(r, int(r, 0, 70));
    if (i % 5 === 0) b.fill(0, 0, Math.min(b.length, 3));
    assert.deepEqual(base58Decode(base58Encode(b)), b);
  }
  assert.equal(base58Encode(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.equal(base58Encode(Uint8Array.from([0, 0, 1])), "112");
  assert.throws(() => base58Decode("0OIl"), /invalid base58/);
});

test("base64 round-trips every byte value", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(base64Encode(all), Buffer.from(all).toString("base64"));
  assert.deepEqual(base64Decode(base64Encode(all)), all);
});

test("KeyPair reads the 64-byte and 32-byte secret-key forms and rejects a mismatched one", async () => {
  const seed = bytes(rng(2), 32);
  const pub = await ed.getPublicKeyAsync(seed);
  const full = await KeyPair.fromString(`ed25519:${base58Encode(Uint8Array.from([...seed, ...pub]))}`);
  const short = await KeyPair.fromString(`ed25519:${base58Encode(seed)}`);
  assert.deepEqual(full.publicKey, pub);
  assert.equal(full.publicKeyString, short.publicKeyString);
  const wrong = Uint8Array.from([...seed, ...pub]);
  wrong[63] = wrong[63]! ^ 1;
  await assert.rejects(KeyPair.fromString(`ed25519:${base58Encode(wrong)}`), /does not match/);
  await assert.rejects(KeyPair.fromString(`secp256k1:${base58Encode(seed)}`), /ed25519/);
});

test("300 random signed transactions encode and sign exactly as @near-js does", async () => {
  const r = rng(20261111);
  for (let i = 0; i < 300; i++) {
    const seed = bytes(r, 32);
    const pub = await ed.getPublicKeyAsync(seed);
    const secret = `ed25519:${base58Encode(Uint8Array.from([...seed, ...pub]))}` as const;
    const ours = await KeyPair.fromString(secret);
    const theirs = NearJsKeyPair.fromString(secret);
    assert.equal(ours.publicKeyString, theirs.getPublicKey().toString());

    const tx: Transaction = {
      signerId: word(r, ACCOUNT_CHARS, 2, 64),
      publicKey: ours.publicKey,
      nonce: bigUint(r, 64),
      receiverId: word(r, ACCOUNT_CHARS, 2, 64),
      blockHash: bytes(r, 32),
      actions: Array.from({ length: int(r, 1, 4) }, () => ({
        methodName: word(r, METHOD_CHARS, 1, 40),
        args: i % 3 === 0 ? bytes(r, int(r, 0, 300)) : new TextEncoder().encode(JSON.stringify({ n: int(r, 0, 1e9), s: word(r, ACCOUNT_CHARS, 0, 20) })),
        gas: bigUint(r, 64),
        deposit: i % 4 === 0 ? 0n : bigUint(r, 128),
      })),
    };
    const reference = createTransaction(
      tx.signerId,
      PublicKey.fromString(ours.publicKeyString),
      tx.receiverId,
      tx.nonce,
      tx.actions.map((a) => actionCreators.functionCall(a.methodName, a.args, a.gas, a.deposit)),
      tx.blockHash,
    );
    const encoded = encodeTransaction(tx);
    assert.deepEqual(encoded, nearJsEncode(reference), `transaction ${i}`);

    const { hash, signature, signed } = await signTransaction(tx, ours);
    assert.deepEqual(hash, sha256(nearJsEncode(reference)));
    const theirSignature = theirs.sign(hash).signature;
    assert.deepEqual(signature, theirSignature, `signature ${i}`);
    const referenceSigned = new SignedTransaction({ transaction: reference, signature: new Signature({ keyType: 0, data: theirSignature }) });
    assert.deepEqual(signed, referenceSigned.encode(), `signed transaction ${i}`);
    assert.equal(decodeSignedTransaction(signed).transaction.nonce, tx.nonce);
  }
});

test("encoding refuses values that do not fit their borsh type", async () => {
  const key = await KeyPair.fromString(`ed25519:${base58Encode(bytes(rng(3), 32))}`);
  const tx: Transaction = {
    signerId: "a.testnet",
    publicKey: key.publicKey,
    nonce: 1n << 64n,
    receiverId: "b.testnet",
    blockHash: new Uint8Array(32),
    actions: [],
  };
  assert.throws(() => encodeTransaction(tx), /nonce does not fit in u64/);
  assert.throws(() => encodeTransaction({ ...tx, nonce: 1n, blockHash: new Uint8Array(31) }), /block hash must be 32 bytes/);
  const action = { methodName: "m", args: new Uint8Array(), gas: 1n, deposit: -1n };
  assert.throws(() => encodeTransaction({ ...tx, nonce: 1n, actions: [action] }), /deposit does not fit/);
});
