// "Connect a NEAR wallet" (lib/wallet.ts) against a fake wallet and a fake chain: the key
// request, the key check, storage, the one setup approval, the refunded deposit, disconnect,
// and the plain text of each failure. No network, no wallet library.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_KEY_METHODS } from "@weir/chain";
import { depositFor, readWallet, WALLET_DEPOSIT, WalletError, walletError, walletGuestKey, walletKey, WalletSession, type ChainReads, type ConnectorLike, type WalletLike } from "./wallet.ts";
import type { KV } from "./try-state.ts";

const WEIR = "weir-h100-fast-w1.testnet";
const USDC = "weir-usdc-w1.testnet";
const ME = "alice.testnet";
const PK = "ed25519:PUBLIC";
const SK = "ed25519:SECRET";

function memKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** A testnet with one account, its keys, its Weir balance and its test dollars. Executes the
 * setup batch the way the contracts would, including Weir sending back a deposit from an
 * account it does not know (SPEC section 5) when `tokenFirst` is set. */
function fakeChain(o: { exists?: boolean } = {}) {
  const st = { exists: o.exists ?? true, keys: new Map<string, unknown>(), weir: null as bigint | null, token: 0n, tokenFirst: false };
  const chain: ChainReads = {
    accountExists: async (id) => id === ME && st.exists,
    accessKey: async (id, pk) => (id === ME ? (st.keys.get(pk) ?? null) : null),
    weirBalance: async (id) => (id === ME && st.weir !== null ? st.weir.toString() : null),
    tokenBalance: async () => st.token.toString(),
  };
  type Tx = { receiverId: string; actions: { type: string; params: Record<string, any> }[] };
  const execute = (txs: Tx[]): unknown[] => {
    const order = st.tokenFirst ? [...txs].sort((a, b) => Number(b.receiverId === USDC) - Number(a.receiverId === USDC)) : txs;
    const outcomes = new Map<Tx, unknown>();
    for (const tx of order) {
      let kept: string | null = null;
      for (const a of tx.actions) {
        if (a.type === "AddKey") st.keys.set(a.params.publicKey, { FunctionCall: { allowance: a.params.accessKey.permission.allowance, receiver_id: a.params.accessKey.permission.receiverId, method_names: a.params.accessKey.permission.methodNames } });
        if (a.type === "FunctionCall" && a.params.methodName === "register") st.weir ??= 0n;
        if (a.type === "FunctionCall" && a.params.methodName === "mint") st.token += BigInt(a.params.args.amount);
        if (a.type === "FunctionCall" && a.params.methodName === "ft_transfer_call") {
          const amt = BigInt(a.params.args.amount);
          if (st.weir === null) kept = "0";
          else {
            st.token -= amt;
            st.weir += amt;
            kept = amt.toString();
          }
        }
      }
      outcomes.set(tx, { status: { SuccessValue: kept === null ? "" : Buffer.from(JSON.stringify(kept)).toString("base64") } });
    }
    return txs.map((t) => outcomes.get(t));
  };
  return { st, chain, execute };
}

/** A wallet that signs in (adding the requested key unless `addsKey` is false) and signs what it is given. */
function fakeWallet(chain: ReturnType<typeof fakeChain>, o: { addsKey?: boolean; account?: string | null; fail?: { connect?: unknown; send?: unknown } } = {}) {
  const calls: { connect: unknown[]; sent: unknown[][]; disconnects: number } = { connect: [], sent: [], disconnects: 0 };
  let signedIn = false;
  const wallet: WalletLike = {
    manifest: { id: "meteor-wallet", name: "Meteor Wallet" },
    getAccounts: async () => (signedIn && o.account !== null ? [{ accountId: o.account ?? ME }] : []),
    signAndSendTransactions: async (p) => {
      if (o.fail?.send) throw o.fail.send;
      calls.sent.push(p.transactions);
      return chain.execute(p.transactions as never);
    },
  };
  const connector: ConnectorLike = {
    connect: async (opts) => {
      calls.connect.push(opts);
      if (o.fail?.connect) throw o.fail.connect;
      signedIn = true;
      const k = opts.addFunctionCallKey;
      if (k && o.addsKey !== false) chain.st.keys.set(k.publicKey, { FunctionCall: { allowance: k.gasAllowance.amount, receiver_id: k.contractId, method_names: k.allowMethods.methodNames } });
      return wallet;
    },
    wallet: async () => wallet,
    disconnect: async () => {
      calls.disconnects++;
      signedIn = false;
    },
  };
  return { wallet, connector, calls };
}

function session(chain: ReturnType<typeof fakeChain>, w: ReturnType<typeof fakeWallet>, kv = memKV()) {
  let keys = 0;
  return {
    kv,
    s: new WalletSession({
      contractId: WEIR,
      usdcId: USDC,
      kv,
      connector: async () => w.connector,
      chain: chain.chain,
      newKey: async () => (keys++ === 0 ? { secretKey: SK, publicKey: PK } : { secretKey: `${SK}${keys}`, publicKey: `${PK}${keys}` }),
      now: () => 1_000,
      sleep: async () => {},
    }),
  };
}

test("connect asks for a function-call key on the market for the page's key, stores it first, and reads the chain", async () => {
  const chain = fakeChain();
  const w = fakeWallet(chain);
  const { s, kv } = session(chain, w);
  const status = await s.connect();
  assert.deepEqual(w.calls.connect, [
    { addFunctionCallKey: { contractId: WEIR, publicKey: PK, allowMethods: { anyMethod: false, methodNames: [...AGENT_KEY_METHODS] }, gasAllowance: { kind: "limited", amount: "250000000000000000000000" } } },
  ]);
  assert.deepEqual(status, { accountId: ME, walletName: "Meteor Wallet", keyOnChain: true, registered: false, balance: 0n, deposit: WALLET_DEPOSIT, ready: false });
  const r = readWallet(kv, WEIR)!;
  assert.equal(r.accountId, ME);
  assert.equal(r.secretKey, SK);
  assert.equal(r.walletId, "meteor-wallet");
  assert.equal(r.phase, "connected");
  assert.deepEqual(s.trading, { accountId: ME, secretKey: SK });
  // Connecting again does not ask the wallet again.
  await s.connect();
  assert.equal(w.calls.connect.length, 1);
});

test("one setup approval: register, then the token transaction; the account is then ready", async () => {
  const chain = fakeChain();
  const w = fakeWallet(chain);
  const { s } = session(chain, w);
  await s.connect();
  const status = await s.setup();
  assert.equal(w.calls.sent.length, 1);
  assert.deepEqual(
    (w.calls.sent[0] as { receiverId: string }[]).map((t) => t.receiverId),
    [WEIR, USDC],
  );
  assert.equal(status.ready, true);
  assert.equal(status.balance, WALLET_DEPOSIT);
  // Ready: a second setup sends nothing.
  await s.setup();
  assert.equal(w.calls.sent.length, 1);
});

test("a wallet that did not add the key at sign-in: the setup batch adds it first", async () => {
  const chain = fakeChain();
  const w = fakeWallet(chain, { addsKey: false });
  const { s } = session(chain, w);
  const first = await s.connect();
  assert.equal(first.keyOnChain, false);
  const status = await s.setup();
  const sent = w.calls.sent[0] as { receiverId: string; actions: { type: string }[] }[];
  assert.deepEqual(
    sent.map((t) => [t.receiverId, t.actions[0]!.type]),
    [
      [ME, "AddKey"],
      [WEIR, "FunctionCall"],
      [USDC, "FunctionCall"],
    ],
  );
  assert.equal(status.ready, true);
});

test("the key still missing after the setup: key-missing, in plain words", async () => {
  const chain = fakeChain();
  const w = fakeWallet(chain, { addsKey: false });
  const { s } = session(chain, w);
  await s.connect();
  // A wallet that drops the AddKey transaction.
  const send = w.wallet.signAndSendTransactions;
  w.wallet.signAndSendTransactions = (p) => send({ ...p, transactions: p.transactions.filter((t) => t.receiverId !== ME) });
  await assert.rejects(s.setup(), (e: unknown) => e instanceof WalletError && e.kind === "key-missing" && /did not add the trading key/.test(e.message));
});

test("deposit refunded (token before registration): refunded, then Deposit again sends the token transaction alone, without minting", async () => {
  const chain = fakeChain();
  chain.st.tokenFirst = true;
  const w = fakeWallet(chain);
  const { s } = session(chain, w);
  await s.connect();
  await assert.rejects(s.setup(), (e: unknown) => e instanceof WalletError && e.kind === "refunded" && /sent them back/.test(e.message));
  assert.equal(chain.st.token, WALLET_DEPOSIT);
  chain.st.tokenFirst = false;
  const status = await s.setup();
  const again = w.calls.sent[1] as { receiverId: string; actions: { params: { methodName: string } }[] }[];
  assert.deepEqual(
    again.map((t) => [t.receiverId, t.actions.map((a) => a.params.methodName)]),
    [[USDC, ["storage_deposit", "ft_transfer_call"]]],
  );
  assert.equal(status.ready, true);
});

test("an account that is not on testnet: no-account, the wallet is signed out, nothing is kept but the key", async () => {
  const chain = fakeChain({ exists: false });
  const w = fakeWallet(chain);
  const { s, kv } = session(chain, w);
  await assert.rejects(s.connect(), (e: unknown) => e instanceof WalletError && e.kind === "no-account" && /alice\.testnet does not exist on NEAR testnet/.test(e.message));
  assert.equal(w.calls.disconnects, 1);
  assert.equal(readWallet(kv, WEIR)!.phase, "connecting");
  assert.equal(s.trading, null);
});

test("closing the wallet, a blocked popup, no testnet: each a plain sentence; the key is kept for the retry", async () => {
  for (const [thrown, kind] of [
    [new Error("User rejected"), "closed"],
    [new Error("Wallet closed"), "closed"],
    [new Error("Failed to sign in"), "closed"],
    [new Error("Popup blocked"), "popup"],
    [{ message: "Testnet is not supported by this wallet" }, "no-testnet"],
    ["Something odd 0xdeadbeef", "unknown"],
  ] as const) {
    const chain = fakeChain();
    const w = fakeWallet(chain, { fail: { connect: thrown } });
    const { s, kv } = session(chain, w);
    await assert.rejects(s.connect(), (e: unknown) => e instanceof WalletError && e.kind === kind && !/0xdeadbeef|Error:/.test(e.message));
    assert.equal(readWallet(kv, WEIR)!.secretKey, SK);
    // The retry uses the same key: a wallet that added it before the window closed is not asked for a second.
    const w2 = fakeWallet(chain);
    const { s: s2 } = session(chain, w2, kv);
    await s2.connect();
    assert.equal((w2.calls.connect[0] as { addFunctionCallKey: { publicKey: string } }).addFunctionCallKey.publicKey, PK);
  }
  // A wallet that returns no account (Intear when its window is closed).
  const chain = fakeChain();
  const w = fakeWallet(chain, { account: null });
  await assert.rejects(session(chain, w).s.connect(), (e: unknown) => e instanceof WalletError && e.kind === "closed");
});

test("the setup closed in the wallet: closed, nothing sent, the record back to connected", async () => {
  const chain = fakeChain();
  const w = fakeWallet(chain, { fail: { send: new Error("User rejected the transactions") } });
  const { s, kv } = session(chain, w);
  await s.connect();
  await assert.rejects(s.setup(), (e: unknown) => e instanceof WalletError && e.kind === "closed");
  assert.equal(readWallet(kv, WEIR)!.phase, "connected");
  assert.equal(chain.st.weir, null);
});

test("allowance used up, in plain words", () => {
  const e = walletError(new Error("Transaction ... NotEnoughAllowance { allowance: 1, cost: 2 }"));
  assert.equal(e.kind, "allowance");
  assert.match(e.message, /used up its gas allowance/);
  assert.doesNotMatch(e.message, /NotEnoughAllowance/);
});

test("disconnect forgets the key and the wallet's guest state, and signs the wallet out", async () => {
  const chain = fakeChain();
  const w = fakeWallet(chain);
  const { s, kv } = session(chain, w);
  await s.connect();
  kv.setItem(walletGuestKey(WEIR), "{}");
  kv.setItem("weir-guest:" + WEIR, "throwaway");
  await s.disconnect();
  assert.equal(kv.getItem(walletKey(WEIR)), null);
  assert.equal(kv.getItem(walletGuestKey(WEIR)), null);
  // The throwaway guest's entry is not the wallet's to forget.
  assert.equal(kv.getItem("weir-guest:" + WEIR), "throwaway");
  assert.equal(w.calls.disconnects, 1);
  assert.equal(s.trading, null);
});

test("depositFor: whole dollars up to 10 USD or the order's most, none when covered", () => {
  assert.equal(depositFor(0n, null), 10_000_000n);
  assert.equal(depositFor(2_500_000n, null), 8_000_000n);
  assert.equal(depositFor(10_000_000n, 4_360_000n), 0n);
  assert.equal(depositFor(0n, 12_300_000n), 13_000_000n);
});

test("a stored record for another market is not read", () => {
  const kv = memKV();
  kv.setItem(walletKey(WEIR), JSON.stringify({ version: 1, contractId: "other.testnet", secretKey: SK }));
  assert.equal(readWallet(kv, WEIR), null);
  kv.setItem(walletKey(WEIR), "not json");
  assert.equal(readWallet(kv, WEIR), null);
});
