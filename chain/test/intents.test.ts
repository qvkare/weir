// The 1Click client offline, against responses saved from the real API on 2026-11-11.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { IntentsClient, summarize, USDC, usdcToNear, usdcUnits, type HttpFetch } from "../src/intents.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function recording(status: number, body: string): { fetch: HttpFetch; calls: { url: string; method: string; body?: string }[] } {
  const calls: { url: string; method: string; body?: string }[] = [];
  return { calls, fetch: async (url, init) => (calls.push({ url, method: init.method, body: init.body }), { status, text: async () => body }) };
}

test("usdcUnits converts whole USDC to base units exactly", () => {
  assert.equal(usdcUnits("20"), "20000000");
  assert.equal(usdcUnits("0.000001"), "1");
  assert.equal(usdcUnits("12.5"), "12500000");
  assert.throws(() => usdcUnits("1.0000001"));
  assert.throws(() => usdcUnits("-3"));
});

test("a quote request carries every required field, dry, with an ISO deadline", () => {
  const req = usdcToNear({ from: "arb", amount: "20000000", recipient: "near", now: new Date("2026-11-11T19:41:35.111Z") });
  assert.deepEqual(req, {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: USDC.arb,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC.near,
    amount: "20000000",
    refundTo: "0x2222222222222222222222222222222222222222",
    refundType: "ORIGIN_CHAIN",
    recipient: "near",
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-11-11T20:41:35.111Z",
  });
});

test("quote posts to /v0/quote and the saved real response summarizes to amount in, out, minimum and time", async () => {
  const { fetch, calls } = recording(201, fixture("quote-arb.json"));
  const client = new IntentsClient({ fetch });
  const req = usdcToNear({ from: "arb", amount: "20000000", recipient: "0".repeat(63) + "1" });
  const res = await client.quote(req);
  assert.equal(calls[0]!.url, "https://1click.chaindefuser.com/v0/quote");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]!.body!), req);
  assert.deepEqual(summarize(res), { amountIn: "20.000000", amountOut: "19.991520", minAmountOut: "19.791604", seconds: 25 });
  assert.equal(res.quoteRequest.dry, true);
});

test("the client refuses to ask for a non-dry quote, and reports API errors with their message", async () => {
  const client = new IntentsClient({ fetch: recording(400, fixture("quote-base-error.json")).fetch });
  assert.throws(() => client.quote({ ...usdcToNear({ from: "base", amount: "1", recipient: "near" }), dry: false }), /only asks for dry quotes/);
  await assert.rejects(client.quote(usdcToNear({ from: "base", amount: "1", recipient: "near" })), /HTTP 400: .*Quoting for this pair is not available/);
});

test("tokens lists USDC on every chain the CLI offers, with the asset ids we use", async () => {
  const { fetch, calls } = recording(200, fixture("tokens-usdc.json"));
  const tokens = await new IntentsClient({ fetch }).tokens();
  assert.equal(calls[0]!.method, "GET");
  assert.ok(calls[0]!.url.endsWith("/v0/tokens"));
  for (const id of Object.values(USDC)) {
    const t = tokens.find((x) => x.assetId === id);
    assert.ok(t, id);
    assert.equal(t.symbol, "USDC");
    assert.equal(t.decimals, 6);
  }
});
