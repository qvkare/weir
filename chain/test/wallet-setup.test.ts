// What a wallet signs for the test bid (src/wallet-setup.ts): the setup batch, the key request
// and the AddKey fallback, as data. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addKeyTx,
  deleteKeyTx,
  isTradingKey,
  signInKeyRequest,
  toWalletTxs,
  TRADING_KEY_ALLOWANCE,
  TRADING_KEY_METHODS,
  transferResult,
  walletSetupBatch,
} from "../src/wallet-setup.ts";
import { setupTransactions } from "../src/guest.ts";
import { AGENT_KEY_METHODS, CALLS } from "../src/weir.ts";
import { TOKEN_CALLS } from "../src/token.ts";

const WEIR = "weir-h100-fast-w1.testnet";
const USDC = "weir-usdc-w1.testnet";
const ME = "alice.testnet";
const PK = "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M";

test("the key request: the market, the page's public key, the agent methods, 0.25 NEAR", () => {
  const r = signInKeyRequest({ contractId: WEIR, publicKey: PK });
  assert.deepEqual(r, {
    contractId: WEIR,
    publicKey: PK,
    allowMethods: { anyMethod: false, methodNames: ["commit", "reveal", "clear", "mint", "merge", "settle", "redeem"] },
    gasAllowance: { kind: "limited", amount: "250000000000000000000000" },
  });
  assert.deepEqual([...TRADING_KEY_METHODS], [...AGENT_KEY_METHODS]);
  assert.ok(!TRADING_KEY_METHODS.includes("withdraw"));
  assert.equal(TRADING_KEY_ALLOWANCE, 250_000_000_000_000_000_000_000n);
});

test("toWalletTxs keeps the order, the receivers and the amounts as decimal strings", () => {
  const setup = setupTransactions({ contractId: WEIR, usdcId: USDC, accountId: ME, deposit: "10000000" });
  const txs = toWalletTxs(setup);
  assert.equal(txs.length, 2);
  assert.deepEqual(txs[0], {
    receiverId: WEIR,
    actions: [{ type: "FunctionCall", params: { methodName: "register", args: {}, gas: CALLS.register.gas.toString(), deposit: "20000000000000000000000" } }],
  });
  assert.equal(txs[1]!.receiverId, USDC);
  assert.deepEqual(
    txs[1]!.actions.map((a) => (a.type === "FunctionCall" ? [a.params.methodName, a.params.args, a.params.gas, a.params.deposit] : null)),
    [
      ["storage_deposit", { account_id: ME, registration_only: true }, TOKEN_CALLS.storage_deposit.gas.toString(), TOKEN_CALLS.storage_deposit.deposit.toString()],
      ["mint", { account_id: ME, amount: "10000000" }, TOKEN_CALLS.mint.gas.toString(), "0"],
      ["ft_transfer_call", { receiver_id: WEIR, amount: "10000000", msg: "" }, TOKEN_CALLS.ft_transfer_call.gas.toString(), "1"],
    ],
  );
  // Plain JSON: no bigint survives into what is posted to the wallet's frame.
  assert.doesNotThrow(() => JSON.stringify(txs));
});

test("the AddKey fallback: from the account to itself, a function-call key on the market", () => {
  assert.deepEqual(addKeyTx({ accountId: ME, contractId: WEIR, publicKey: PK }), {
    receiverId: ME,
    actions: [{ type: "AddKey", params: { publicKey: PK, accessKey: { permission: { receiverId: WEIR, allowance: "250000000000000000000000", methodNames: [...AGENT_KEY_METHODS] } } } }],
  });
  assert.deepEqual(deleteKeyTx({ accountId: ME, publicKey: PK }), { receiverId: ME, actions: [{ type: "DeleteKey", params: { publicKey: PK } }] });
});

test("the setup batch: key first when missing, then register, then the token transaction", () => {
  const all = walletSetupBatch({ accountId: ME, contractId: WEIR, usdcId: USDC, publicKey: PK, deposit: "10000000", addKey: true, register: true });
  assert.deepEqual(
    all.map((t) => t.receiverId),
    [ME, WEIR, USDC],
  );
  const noKey = walletSetupBatch({ accountId: ME, contractId: WEIR, usdcId: USDC, publicKey: PK, deposit: "10000000", addKey: false, register: true });
  assert.deepEqual(
    noKey.map((t) => t.receiverId),
    [WEIR, USDC],
  );
  // Deposit again after a refund: the token transaction only, and no mint when the dollars are back.
  const again = walletSetupBatch({ accountId: ME, contractId: WEIR, usdcId: USDC, publicKey: PK, deposit: "10000000", mint: "0", addKey: false, register: false });
  assert.equal(again.length, 1);
  assert.deepEqual(
    again[0]!.actions.map((a) => (a.type === "FunctionCall" ? a.params.methodName : a.type)),
    ["storage_deposit", "ft_transfer_call"],
  );
  // Registered and funded, key present: nothing to sign.
  assert.deepEqual(walletSetupBatch({ accountId: ME, contractId: WEIR, usdcId: USDC, publicKey: PK, deposit: "0", addKey: false, register: false }), []);
});

test("isTradingKey reads view_access_key's permission", () => {
  assert.equal(isTradingKey({ FunctionCall: { allowance: "1", receiver_id: WEIR, method_names: [...AGENT_KEY_METHODS] } }, WEIR), true);
  assert.equal(isTradingKey({ FunctionCall: { allowance: null, receiver_id: WEIR, method_names: [] } }, WEIR), true);
  assert.equal(isTradingKey({ FunctionCall: { allowance: "1", receiver_id: USDC, method_names: ["commit", "reveal"] } }, WEIR), false);
  assert.equal(isTradingKey({ FunctionCall: { allowance: "1", receiver_id: WEIR, method_names: ["settle"] } }, WEIR), false);
  assert.equal(isTradingKey("FullAccess", WEIR), false);
  assert.equal(isTradingKey(null, WEIR), false);
});

test("transferResult decodes the amount Weir kept from a final outcome", () => {
  const ok = { status: { SuccessValue: Buffer.from(JSON.stringify("10000000")).toString("base64") } };
  assert.equal(transferResult(ok), "10000000");
  const refunded = { status: { SuccessValue: Buffer.from(JSON.stringify("0")).toString("base64") } };
  assert.equal(transferResult(refunded), "0");
  assert.equal(transferResult({ status: { Failure: {} } }), null);
  assert.equal(transferResult(undefined), null);
  assert.equal(transferResult({ status: { SuccessValue: "" } }), null);
});
