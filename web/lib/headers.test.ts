// The security headers' strings: what the browser may connect to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectSources, csp, FAUCET_ORIGIN, securityHeaders, WALLET_CONNECT_ORIGINS, WALLET_FRAME_ORIGINS } from "./headers.ts";

const testnet = { network: "testnet", rpc: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org/"], bundlesBase: "https://weir-keeper.qvkare.workers.dev/bundles" };

const WALLETS = ["https://raw.githubusercontent.com", "https://wallet.intear.tech", "wss://logout-bridge-service.intear.tech", "https://rpc.testnet.near.org"];

test("connect-src: this site, the RPC origins, the bundle host and, on testnet, the faucet and the wallets' origins; nothing else", () => {
  assert.deepEqual(connectSources(testnet), ["'self'", "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://weir-keeper.qvkare.workers.dev", "https://helper.nearprotocol.com", ...WALLETS]);
  assert.equal(FAUCET_ORIGIN, "https://helper.nearprotocol.com");
  assert.deepEqual([...WALLET_CONNECT_ORIGINS], WALLETS);
  const policy = csp(testnet);
  assert.match(policy, /(^|; )connect-src 'self' https:\/\/test\.rpc\.fastnear\.com https:\/\/near-testnet\.drpc\.org https:\/\/weir-keeper\.qvkare\.workers\.dev https:\/\/helper\.nearprotocol\.com https:\/\/raw\.githubusercontent\.com https:\/\/wallet\.intear\.tech wss:\/\/logout-bridge-service\.intear\.tech https:\/\/rpc\.testnet\.near\.org(;|$)/);
  // The wallets' scripts are fetched and run inline in a sandboxed frame: no remote script source, no eval.
  assert.match(policy, /(^|; )script-src 'self' 'unsafe-inline'(;|$)/);
  // Frames: this site and Intear's sign-in frame only. Images: this site and data: (the manifest's icons are inlined).
  assert.deepEqual([...WALLET_FRAME_ORIGINS], ["https://wallet.intear.tech"]);
  assert.match(policy, /(^|; )frame-src 'self' https:\/\/wallet\.intear\.tech(;|$)/);
  assert.match(policy, /(^|; )img-src 'self' data: blob:(;|$)/);
  assert.equal(policy.split("raw.githubusercontent.com").length, 2);
  // The faucet is in connect-src only: no script, frame or form may come from it.
  assert.equal(policy.split("helper.nearprotocol.com").length, 2);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /form-action 'self'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
});

test("no faucet and no wallet origins off testnet, and no duplicate origins", () => {
  const mainnet = { network: "mainnet", rpc: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.fastnear.com/x"], bundlesBase: null };
  assert.deepEqual(connectSources(mainnet), ["'self'", "https://rpc.mainnet.fastnear.com"]);
  assert.match(csp(mainnet), /(^|; )frame-src 'self'(;|$)/);
});

test("every response's headers carry the policy and the four others", () => {
  const h = securityHeaders(testnet);
  assert.deepEqual(Object.keys(h), ["Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Strict-Transport-Security"]);
  assert.equal(h["Content-Security-Policy"], csp(testnet));
  assert.match(csp(testnet, true), /connect-src [^;]* ws: http:\/\/localhost:\*/);
});
