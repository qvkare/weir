// What the header reads of the wallet record, the account name it shows, and the test bid's
// `?connect=1` request. No browser: storage is a Map, the address a string.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedAccount, shortAccount, takeConnectRequest, walletKey, type WalletRecord } from "./wallet-record.ts";

const C = "weir-h100-fast-w1.testnet";
const IMPLICIT = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function kvWith(r: Partial<WalletRecord> | string | null): { getItem(k: string): string | null } {
  const data = new Map<string, string>();
  if (typeof r === "string") data.set(walletKey(C), r);
  else if (r) data.set(walletKey(C), JSON.stringify({ version: 1, contractId: C, secretKey: "ed25519:x", publicKey: "ed25519:y", walletId: "w", accountId: null, phase: "connecting", since: 0, ...r }));
  return { getItem: (k) => data.get(k) ?? null };
}

test("shortAccount keeps short names and cuts long ones in the middle to 14 characters", () => {
  assert.equal(shortAccount("qvkare.testnet"), "qvkare.testnet");
  assert.equal(shortAccount("qvkareweir.testnet"), "qvkare…testnet");
  assert.equal(shortAccount("alice.bob.testnet"), "alice…testnet");
  assert.equal(shortAccount(IMPLICIT), "9f86d0818…0a08");
  assert.equal(shortAccount("0x52908400098527886e0f7030069857d2e4169ee7"), "0x5290840…9ee7");
  // A last part too long to keep: both ends instead.
  assert.equal(shortAccount("someone.verylongsuffix"), "someone.v…ffix");
  for (const id of ["qvkareweir.testnet", IMPLICIT, "a".repeat(64), "x.".repeat(30) + "near"]) {
    assert.ok(shortAccount(id).length <= 14, id);
    assert.ok(shortAccount(id, 24).length <= 24, id);
  }
  assert.equal(shortAccount(IMPLICIT, 24), "9f86d081884c7d65…0f00a08");
});

test("connectedAccount: the account once signed in, nothing before or when unreadable", () => {
  assert.equal(connectedAccount(kvWith({ accountId: "qvkare.testnet", phase: "connected" }), C), "qvkare.testnet");
  assert.equal(connectedAccount(kvWith({ accountId: "qvkare.testnet", phase: "setup" }), C), "qvkare.testnet");
  assert.equal(connectedAccount(kvWith({ accountId: "qvkare.testnet", phase: "connecting" }), C), null);
  assert.equal(connectedAccount(kvWith({ phase: "connecting" }), C), null);
  assert.equal(connectedAccount(kvWith(null), C), null);
  assert.equal(connectedAccount(kvWith("{not json"), C), null);
  assert.equal(connectedAccount(kvWith({ accountId: "qvkare.testnet", phase: "connected", contractId: "other.testnet" }), C), null);
  assert.equal(connectedAccount(kvWith({ accountId: "qvkare.testnet", phase: "connected" }), "other.testnet"), null);
  assert.equal(connectedAccount(null, C), null);
  assert.equal(connectedAccount(kvWith({ accountId: "qvkare.testnet", phase: "connected" }), null), null);
  const throwing = { getItem: (): string | null => { throw new Error("blocked"); } };
  assert.equal(connectedAccount(throwing, C), null);
});

test("?connect=1 opens the chooser once and leaves the address without it", () => {
  let addr = "https://tryweir.com/m/h100-fast/try?connect=1";
  const replaced: string[] = [];
  const replace = (u: string) => {
    replaced.push(u);
    addr = new URL(u, addr).href;
  };
  assert.deepEqual(takeConnectRequest(addr, false, replace), { wallet: true, open: true });
  assert.deepEqual(replaced, ["/m/h100-fast/try"]);
  // A reload sees the cleaned address: nothing opens, nothing is replaced.
  assert.deepEqual(takeConnectRequest(addr, false, replace), { wallet: false, open: false });
  assert.equal(replaced.length, 1);
});

test("?connect=1 with a wallet already connected selects the wallet mode and opens nothing", () => {
  const replaced: string[] = [];
  assert.deepEqual(takeConnectRequest("https://tryweir.com/m/h100-fast/try?connect=1", true, (u) => replaced.push(u)), { wallet: true, open: false });
  assert.deepEqual(replaced, ["/m/h100-fast/try"]);
});

test("?connect= keeps the other parameters and the anchor; other values are removed without opening", () => {
  const replaced: string[] = [];
  assert.deepEqual(takeConnectRequest("http://localhost:3211/m/h100-fast/try?x=2&connect=1#steps", false, (u) => replaced.push(u)), { wallet: true, open: true });
  assert.deepEqual(takeConnectRequest("http://localhost:3211/m/h100-fast/try?connect=0", false, (u) => replaced.push(u)), { wallet: false, open: false });
  assert.deepEqual(replaced, ["/m/h100-fast/try?x=2#steps", "/m/h100-fast/try"]);
  assert.deepEqual(takeConnectRequest("not a url", false, () => assert.fail("no replace")), { wallet: false, open: false });
});
