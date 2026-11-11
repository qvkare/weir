import assert from "node:assert/strict";
import { test } from "node:test";
import { computeIndex, makeBundle, median, providersFrom, toMicro, type Draft, type Kind, type Outcome, type Provider, type Source } from "../src/method.ts";
import { fixtureOutcomes } from "./fixtures.ts";

test("toMicro: exact decimal, half up, no float drift", () => {
  assert.equal(toMicro("5.087"), 5_087_000);
  assert.equal(toMicro("20.35", 4), 5_087_500);
  assert.equal(toMicro(0.1 + 0.2), 300_000); // 0.30000000000000004
  assert.equal(toMicro("0.0000005"), 1); // half up
  assert.equal(toMicro("0.00000049"), 0);
  assert.equal(toMicro(1434, 800), 1_792_500); // cents per 8 GPUs
  assert.equal(toMicro(1e-7), 0);
  assert.equal(toMicro(2.5355555555555553), 2_535_556);
  assert.throws(() => toMicro("-1"));
  assert.throws(() => toMicro("1,5"));
});

test("median: odd takes the middle, even takes the floor of the mean of the middle two", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2); // (2 + 3) / 2 = 2.5 -> 2
  assert.equal(median([10, 11]), 10);
  assert.equal(median([7]), 7);
  assert.throws(() => median([]));
});

function src(id: string, kind: Kind, drafts: Draft[], aggregator = false): Source {
  return { id, kind, url: `https://example.test/${id}`, method: "GET", aggregator, parse: () => drafts };
}
const outcome = (source: Source): Outcome => ({ source, body: "{}", raw_sha256: "0".repeat(64) });
const offers = (...usd: number[]) => usd.map((u, i) => ({ sku: `s${i}`, price: Math.round(u * 1e6) }));

test("vast: one price per host, at least 3 hosts", () => {
  const two = [{ sku: "1/a", price: 2_000_000 }, { sku: "1/b", price: 9_000_000 }, { sku: "2/c", price: 3_000_000 }];
  const [p2] = providersFrom(outcome(src("vast", "open-market", [{ id: "vast", offers: two }])));
  assert.equal(p2!.status, "excluded");
  assert.equal(p2!.reason, "too few hosts (2)");
  // Host 1 has three offers but still one vote: hosts 1 -> 5.0, 2 -> 3.0, 3 -> 4.0.
  const three = [...two, { sku: "1/d", price: 5_000_000 }, { sku: "3/e", price: 4_000_000 }];
  const [p3] = providersFrom(outcome(src("vast", "open-market", [{ id: "vast", offers: three }])));
  assert.equal(p3!.status, "included");
  assert.equal(p3!.value, 4_000_000);
});

test("bounds and empty providers are excluded with a reason", () => {
  const ps = providersFrom(outcome(src("agg", "rate-card", [
    { id: "cheap", offers: offers(0.19) },
    { id: "edge-low", offers: offers(0.2) },
    { id: "edge-high", offers: offers(50) },
    { id: "dear", offers: offers(50.01) },
    { id: "empty", offers: [] },
  ])));
  const by = Object.fromEntries(ps.map((p) => [p.id, p.reason ?? p.status]));
  assert.deepEqual(by, {
    cheap: "value 0.19 outside 0.20 to 50.00 USD",
    "edge-low": "included",
    "edge-high": "included",
    dear: "value 50.01 outside 0.20 to 50.00 USD",
    empty: "no qualifying offer",
  });
});

test("aggregator rows for a direct source's company are dropped as duplicates", () => {
  const ps = providersFrom(outcome(src("shadeform", "rate-card", [
    { id: "datacrunch", offers: offers(2) },
    { id: "vastai", offers: offers(2) },
    { id: "RunPod", offers: offers(2) },
    { id: "lambdalabs", offers: offers(2) },
  ], true)));
  assert.deepEqual(ps.map((p) => [p.id, p.reason ?? p.status]), [
    ["shadeform:datacrunch", "duplicate of verda"],
    ["shadeform:vastai", "duplicate of vast"],
    ["shadeform:RunPod", "duplicate of runpod"],
    ["lambdalabs", "included"],
  ]);
});

test("a failed fetch or unreadable body excludes the source, nothing carried forward", () => {
  const s = src("verda", "rate-card", []);
  const [failed] = providersFrom({ source: s, body: null, raw_sha256: "0".repeat(64), error: "HTTP 503" });
  assert.equal(failed!.reason, "fetch failed: HTTP 503");
  assert.equal(failed!.value, undefined);
  const [bad] = providersFrom({ source: s, body: "<html>", raw_sha256: "0".repeat(64) });
  assert.match(bad!.reason!, /^unreadable response: /);
});

function provs(...spec: [Kind, number][]): Provider[] {
  return spec.map(([kind, usd], i) => ({
    id: `p${i}`, kind, source: "x", url: "", status: "included", value: Math.round(usd * 1e6), offers: [], raw_sha256: "",
  }));
}

test("index needs 6 providers, 3 of them rate cards, and is their median", () => {
  const five = provs(["rate-card", 1], ["rate-card", 2], ["rate-card", 3], ["open-market", 4], ["open-market", 5]);
  assert.deepEqual(computeIndex(five), { index: null, reason: "5 providers included, need 6" });
  const twoRate = provs(["rate-card", 1], ["rate-card", 2], ["open-market", 3], ["open-market", 4], ["open-market", 5], ["open-market", 6]);
  assert.deepEqual(computeIndex(twoRate), { index: null, reason: "2 rate-card providers included, need 3" });
  const ok = provs(["rate-card", 1], ["rate-card", 2], ["rate-card", 3], ["open-market", 4], ["open-market", 5], ["open-market", 6]);
  assert.deepEqual(computeIndex(ok), { index: 3_500_000 });
  const excluded = [...ok.slice(1), { ...ok[0]!, status: "excluded" as const, value: undefined }];
  assert.equal(computeIndex(excluded).index, null);
});

test("the saved responses give an index of 2.76 USD from 18 providers", async () => {
  const b = makeBundle(1_794_423_600, 1_794_425_132, await fixtureOutcomes());
  const included = b.providers.filter((p) => p.status === "included");
  assert.equal(included.length, 18);
  assert.deepEqual(b.providers.filter((p) => p.status === "excluded").map((p) => [p.id, p.reason]), [["shadeform:verda", "duplicate of verda"]]);
  // Sorted values; the 9th and 10th are massedcompute 2.73 and runpod 2.79.
  assert.equal(b.index, 2_760_000);
  assert.deepEqual(b.providers.map((p) => p.id), [...b.providers.map((p) => p.id)].sort());
});
