// The security headers' strings: what the browser may connect to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectSources, csp, FAUCET_ORIGIN, securityHeaders } from "./headers.ts";

const testnet = { network: "testnet", rpc: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org/"], bundlesBase: "https://weir-keeper.qvkare.workers.dev/bundles" };

test("connect-src: this site, the RPC origins, the bundle host and, on testnet, the faucet; nothing else", () => {
  assert.deepEqual(connectSources(testnet), ["'self'", "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://weir-keeper.qvkare.workers.dev", "https://helper.nearprotocol.com"]);
  assert.equal(FAUCET_ORIGIN, "https://helper.nearprotocol.com");
  const policy = csp(testnet);
  assert.match(policy, /(^|; )connect-src 'self' https:\/\/test\.rpc\.fastnear\.com https:\/\/near-testnet\.drpc\.org https:\/\/weir-keeper\.qvkare\.workers\.dev https:\/\/helper\.nearprotocol\.com(;|$)/);
  // The faucet is in connect-src only: no script, frame or form may come from it.
  assert.equal(policy.split("helper.nearprotocol.com").length, 2);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /form-action 'self'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
});

test("no faucet off testnet, and no duplicate origins", () => {
  assert.deepEqual(connectSources({ network: "mainnet", rpc: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.fastnear.com/x"], bundlesBase: null }), ["'self'", "https://rpc.mainnet.fastnear.com"]);
});

test("every response's headers carry the policy and the four others", () => {
  const h = securityHeaders(testnet);
  assert.deepEqual(Object.keys(h), ["Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Strict-Transport-Security"]);
  assert.equal(h["Content-Security-Policy"], csp(testnet));
  assert.match(csp(testnet, true), /connect-src [^;]* ws: http:\/\/localhost:\*/);
});
