// The token calls send NEP-141/145 argument names with the deposits the standards require.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NearAccount, NearRpc } from "../src/near.ts";
import { STORAGE_DEPOSIT, Token } from "../src/token.ts";
import { base58Encode, KeyPair } from "../src/tx.ts";
import { fakeNear } from "./fake_near.ts";

test("storage_deposit, ft_transfer_call into Weir, mint and ft_balance_of", async () => {
  const fake = fakeNear();
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  const signer = new NearAccount(rpc, "a.testnet", await KeyPair.fromString(`ed25519:${base58Encode(new Uint8Array(32).fill(4))}`));
  const usdc = new Token(rpc, "usdc.testnet");
  await usdc.storageDeposit(signer);
  await usdc.depositToWeir(signer, "weir.testnet", "5000000");
  await usdc.depositToWeir(signer, "weir.testnet", "5000000", "b.testnet");
  await usdc.mint(signer, "a.testnet", "100000000");
  const rows = fake.sent.map((s) => [s.receiver, s.method, s.args, s.deposit]);
  assert.deepEqual(rows, [
    ["usdc.testnet", "storage_deposit", { account_id: "a.testnet", registration_only: true }, STORAGE_DEPOSIT],
    ["usdc.testnet", "ft_transfer_call", { receiver_id: "weir.testnet", amount: "5000000", msg: "" }, 1n],
    ["usdc.testnet", "ft_transfer_call", { receiver_id: "weir.testnet", amount: "5000000", msg: "b.testnet" }, 1n],
    ["usdc.testnet", "mint", { account_id: "a.testnet", amount: "100000000" }, 0n],
  ]);
  await usdc.balanceOf("a.testnet");
  const last = fake.requests.at(-1)!.params;
  assert.equal(last.method_name, "ft_balance_of");
  assert.deepEqual(JSON.parse(atob(last.args_base64 as string)), { account_id: "a.testnet" });
});
