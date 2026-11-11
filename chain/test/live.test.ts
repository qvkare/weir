// One read-only call to NEAR testnet, skipped unless WEIR_LIVE=1. No key, no transaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NearRpc } from "../src/near.ts";

const USDC_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

test("live: ft_metadata of testnet USDC through fastnear", { skip: process.env.WEIR_LIVE !== "1" && "set WEIR_LIVE=1 to run" }, async (t) => {
  const rpc = new NearRpc({ urls: ["https://test.rpc.fastnear.com"], timeoutMs: 15_000 });
  const meta = await rpc.view<{ symbol: string; decimals: number; name: string; spec: string }>(USDC_TESTNET, "ft_metadata");
  t.diagnostic(`ft_metadata: ${JSON.stringify({ spec: meta.spec, name: meta.name, symbol: meta.symbol, decimals: meta.decimals })}`);
  assert.equal(meta.decimals, 6);
  assert.match(meta.symbol, /USDC/);
});
