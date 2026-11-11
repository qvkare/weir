// The account-setup actions (create account, deploy, transfer, add key) against @near-js, in
// random mixes with function calls, signed.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as ed from "@noble/ed25519";
import { KeyPair as NearJsKeyPair, PublicKey } from "@near-js/crypto";
import { actionCreators, createTransaction, encodeTransaction as nearJsEncode, SignedTransaction, Signature } from "@near-js/transactions";
import { base58Encode, encodeTransaction, KeyPair, signTransaction, type Action, type AnyTransaction } from "../src/tx.ts";
import { bigUint, bytes, int, rng } from "./rng.ts";

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_";
const word = (r: () => number, lo: number, hi: number) => Array.from({ length: int(r, lo, hi) }, () => CHARS[int(r, 0, CHARS.length - 1)]).join("");

test("200 random transactions with setup actions encode and sign exactly as @near-js does", async () => {
  const r = rng(20261112);
  for (let i = 0; i < 200; i++) {
    const seed = bytes(r, 32);
    const pub = await ed.getPublicKeyAsync(seed);
    const secret = `ed25519:${base58Encode(Uint8Array.from([...seed, ...pub]))}` as const;
    const ours = await KeyPair.fromString(secret);
    const theirs = NearJsKeyPair.fromString(secret);
    const ourActions: Action[] = [];
    const theirActions = [];
    for (let j = int(r, 1, 6); j > 0; j--) {
      const kind = int(r, 0, 5);
      if (kind === 0) {
        ourActions.push({ type: "CreateAccount" });
        theirActions.push(actionCreators.createAccount());
      } else if (kind === 1) {
        const code = bytes(r, int(r, 0, 2000));
        ourActions.push({ type: "DeployContract", code });
        theirActions.push(actionCreators.deployContract(code));
      } else if (kind === 2) {
        const deposit = bigUint(r, 128);
        ourActions.push({ type: "Transfer", deposit });
        theirActions.push(actionCreators.transfer(deposit));
      } else if (kind === 3 || kind === 4) {
        const keyPub = await ed.getPublicKeyAsync(bytes(r, 32));
        const pk = PublicKey.fromString(`ed25519:${base58Encode(keyPub)}`);
        if (kind === 3) {
          ourActions.push({ type: "AddKey", publicKey: keyPub, permission: "FullAccess" });
          theirActions.push(actionCreators.addKey(pk, actionCreators.fullAccessKey()));
        } else {
          const receiverId = word(r, 2, 40);
          const methodNames = Array.from({ length: int(r, 0, 8) }, () => word(r, 1, 20));
          const allowance = int(r, 0, 1) === 0 ? null : bigUint(r, 128);
          ourActions.push({ type: "AddKey", publicKey: keyPub, permission: { receiverId, methodNames, allowance } });
          theirActions.push(actionCreators.addKey(pk, actionCreators.functionCallAccessKey(receiverId, methodNames, allowance ?? undefined)));
        }
      } else {
        const fc = { methodName: word(r, 1, 30), args: bytes(r, int(r, 0, 100)), gas: bigUint(r, 64), deposit: bigUint(r, 128) };
        ourActions.push(fc);
        theirActions.push(actionCreators.functionCall(fc.methodName, fc.args, fc.gas, fc.deposit));
      }
    }
    const tx: AnyTransaction = {
      signerId: word(r, 2, 64),
      publicKey: ours.publicKey,
      nonce: bigUint(r, 64),
      receiverId: word(r, 2, 64),
      blockHash: bytes(r, 32),
      actions: ourActions,
    };
    const reference = createTransaction(tx.signerId, PublicKey.fromString(ours.publicKeyString), tx.receiverId, tx.nonce, theirActions, tx.blockHash);
    assert.deepEqual(encodeTransaction(tx), nearJsEncode(reference), `transaction ${i}`);
    const { hash, signed } = await signTransaction(tx, ours);
    const referenceSigned = new SignedTransaction({ transaction: reference, signature: new Signature({ keyType: 0, data: theirs.sign(hash).signature }) });
    assert.deepEqual(signed, referenceSigned.encode(), `signed transaction ${i}`);
  }
});

test("setup actions refuse values that do not fit", async () => {
  const key = await KeyPair.fromString(`ed25519:${base58Encode(bytes(rng(4), 32))}`);
  const tx = (actions: Action[]): AnyTransaction => ({ signerId: "a.test", publicKey: key.publicKey, nonce: 1n, receiverId: "b.test", blockHash: new Uint8Array(32), actions });
  assert.throws(() => encodeTransaction(tx([{ type: "Transfer", deposit: 1n << 128n }])), /deposit does not fit/);
  assert.throws(() => encodeTransaction(tx([{ type: "AddKey", publicKey: new Uint8Array(31), permission: "FullAccess" }])), /public key must be 32 bytes/);
  assert.throws(
    () => encodeTransaction(tx([{ type: "AddKey", publicKey: key.publicKey, permission: { receiverId: "c", methodNames: [], allowance: -1n } }])),
    /allowance does not fit/,
  );
});
