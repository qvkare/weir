import assert from "node:assert/strict";
import { test } from "node:test";
import { CHIPS } from "../src/chips.ts";
import {
  computeIndex, contextOf, makeBundle, median, METHOD_ID, providersFrom, splitPlaceholders, toMicro,
  type Bundle, type Draft, type Kind, type Outcome, type Provider, type Source,
} from "../src/method.ts";
import { fixtureOutcomes, v2Outcomes } from "./fixtures.ts";

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

test("the first day's responses still give 2.76 USD from 18 providers under version 2", async () => {
  const b = makeBundle(1_794_423_600, 1_794_425_132, await fixtureOutcomes());
  assert.deepEqual([b.method, b.chip, b.index_name], [METHOD_ID, "h100", "H100-OD"]);
  assert.equal(b.providers.some((p) => p.dropped), false); // nothing below 25% of 2.75
  const included = b.providers.filter((p) => p.status === "included");
  assert.equal(included.length, 18);
  assert.deepEqual(b.providers.filter((p) => p.status === "excluded").map((p) => [p.id, p.reason]), [["shadeform:verda", "duplicate of verda"]]);
  // Sorted values; the 9th and 10th are massedcompute 2.73 and runpod 2.79.
  assert.equal(b.index, 2_760_000);
  assert.deepEqual(b.providers.map((p) => p.id), [...b.providers.map((p) => p.id)].sort());
});

// ---- Version 2 rules on the second day's responses.

const by = (b: Bundle) => Object.fromEntries(b.providers.map((p) => [p.id, p]));
const counts = (b: Bundle) => {
  const inc = b.providers.filter((p) => p.status === "included");
  return [inc.length, inc.filter((p) => p.kind === "rate-card").length];
};

test("each chip's index on the second day, with provider counts", async () => {
  const run = async (c: (typeof CHIPS)[keyof typeof CHIPS]) => makeBundle(1_794_430_800, 1_794_433_000, await v2Outcomes(c), c);
  const h100 = await run(CHIPS.h100);
  // 17 values; the 9th is lium 2.90 (vast is out with one verified host).
  assert.deepEqual([h100.index, counts(h100)], [2_900_000, [17, 15]]);
  assert.equal(by(h100).vast!.reason, "too few hosts (1)");
  assert.equal(by(h100).vast!.note, "1 offers returned, under the 64-offer cap");
  const h200 = await run(CHIPS.h200);
  // horizon 3.00, runpod 3.79, vast 4.002222, lium 4.08, boostrun 4.25, digitalocean 4.47,
  // excesssupply 4.51625, nebius 4.573125, verda 6.5045: the 5th.
  assert.deepEqual([h200.index, counts(h200)], [4_250_000, [9, 7]]);
  const a100 = await run(CHIPS["a100-80"]);
  // 1.35, 1.35, 1.365, 1.49, 1.5125, 1.59 (runpod), 2.00, 2.339, 2.60, 2.79, 3.23: the 6th.
  assert.deepEqual([a100.index, counts(a100)], [1_590_000, [11, 10]]);
  assert.equal(by(a100).vast!.reason, "too few hosts (2)");
  assert.equal(by(a100).lium!.reason, "no qualifying offer");
});

test("placeholder rule: RunPod's 0.50 H200 NVL is dropped, recorded and not counted", async () => {
  const b = makeBundle(0, 0, await v2Outcomes(CHIPS.h200), CHIPS.h200);
  // 50 offers parsed for H200 across all providers; their median is 4.25, a quarter of it 1.0625.
  assert.equal(contextOf(b).reference, 4_250_000);
  const runpod = by(b).runpod!;
  assert.deepEqual(runpod.dropped, [{ sku: "NVIDIA H200 NVL community", price: 500_000, reason: "placeholder: below 25% of the median offer 4.25 USD" }]);
  assert.equal(runpod.offers.length, 3);
  assert.equal(runpod.value, 3_790_000); // 3.59, 3.79, 5.29; with the 0.50 it would have been (3.59 + 3.79) / 2
  assert.equal(b.providers.filter((p) => p.dropped).length, 1);
});

test("placeholder rule: strict 25% boundary, zero dropped, all-dropped provider excluded", () => {
  assert.deepEqual(splitPlaceholders([{ sku: "a", price: 1_000_000 }, { sku: "b", price: 999_999 }, { sku: "c", price: 0 }], 4_000_000), {
    offers: [{ sku: "a", price: 1_000_000 }], // exactly 25% stays
    dropped: [
      { sku: "b", price: 999_999, reason: "placeholder: below 25% of the median offer 4.00 USD" },
      { sku: "c", price: 0, reason: "placeholder: below 25% of the median offer 4.00 USD" },
    ],
  });
  const ps = providersFrom(outcome(src("x", "rate-card", [{ id: "junk", offers: offers(0, 0.5) }])), { version: 2, reference: 4_000_000, failedDirect: new Set() });
  assert.deepEqual([ps[0]!.status, ps[0]!.reason, ps[0]!.offers, ps[0]!.dropped!.length], ["excluded", "no qualifying offer", [], 2]);
  // Version 1 never drops.
  const v1 = providersFrom(outcome(src("x", "rate-card", [{ id: "junk", offers: offers(0.5, 3) }])), { version: 1, reference: 4_000_000, failedDirect: new Set() });
  assert.equal(v1[0]!.dropped, undefined);
});

test("Verda fallback: when the direct fetch fails, Shadeform's Verda rows stand in", async () => {
  const ok = by(makeBundle(0, 0, await v2Outcomes(CHIPS.h100), CHIPS.h100));
  assert.deepEqual([ok.verda!.value, ok["shadeform:verda"]!.reason], [5_087_000, "duplicate of verda"]);
  const b = makeBundle(0, 0, await v2Outcomes(CHIPS.h100, ["verda"]), CHIPS.h100);
  const p = by(b);
  assert.equal(p.verda!.reason, "fetch failed: HTTP 503");
  const stand = p["shadeform:verda"]!;
  assert.deepEqual([stand.status, stand.value, stand.kind], ["included", 3_310_000, "rate-card"]); // 3.31 via Shadeform
  assert.equal(stand.note, "stands in for verda, whose direct response could not be used");
  assert.deepEqual(counts(b), [17, 15]); // one vote for Verda either way
  // An unreadable body counts as a failure too; a direct source with no offers does not.
  const bad = (await v2Outcomes(CHIPS.h100)).map((o) => (o.source.id === "verda" ? { ...o, body: "<html>" } : o));
  assert.equal(by(makeBundle(0, 0, bad, CHIPS.h100))["shadeform:verda"]!.status, "included");
  const empty = (await v2Outcomes(CHIPS.h100)).map((o) => (o.source.id === "verda" ? { ...o, body: "[]" } : o));
  assert.equal(by(makeBundle(0, 0, empty, CHIPS.h100))["shadeform:verda"]!.reason, "duplicate of verda");
});

test("per-chip minimums: each chip needs 6 providers and 3 rate cards", async () => {
  for (const chip of Object.values(CHIPS)) {
    // Without Shadeform no chip keeps 6 providers: it is every chip's single largest dependency.
    const b = makeBundle(0, 0, await v2Outcomes(chip, ["shadeform"]), chip);
    assert.equal(b.index, null, chip.id);
    assert.match(b.reason!, /^\d providers included, need 6$/, chip.id);
  }
  for (const chip of Object.values(CHIPS)) {
    const b = makeBundle(0, 0, await v2Outcomes(chip), chip);
    const inc = b.providers.filter((p) => p.status === "included");
    assert.notEqual(computeIndex(inc.slice(0, 6)).index, null, chip.id); // the first six by id include 3 rate cards
    assert.deepEqual(computeIndex(inc.slice(0, 5)), { index: null, reason: "5 providers included, need 6" }, chip.id);
    const twoRate = [...inc.filter((p) => p.kind === "open-market"), ...inc.filter((p) => p.kind === "rate-card").slice(0, 2)];
    assert.equal(computeIndex(twoRate).index, null, chip.id); // fewer than 6 here, or too few rate cards
  }
});
