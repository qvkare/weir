// Each parser against the real response saved on 2026-11-11. Expected values were worked
// out by hand from the fixture files (see the comments) and are not produced by the code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { providerValue } from "../src/method.ts";
import * as akash from "../src/sources/akash.ts";
import * as lium from "../src/sources/lium.ts";
import * as runpod from "../src/sources/runpod.ts";
import * as shadeform from "../src/sources/shadeform.ts";
import * as vast from "../src/sources/vast.ts";
import * as verda from "../src/sources/verda.ts";
import { fixture } from "./fixtures.ts";

const prices = (offers: { price: number }[]) => offers.map((o) => o.price).sort((a, b) => a - b);

test("vast: verified, reliability2 >= 0.95, dph_total / num_gpus, one price per host", () => {
  const offers = vast.parse(fixture("vast"));
  // 22 offers; 7 are verified with reliability2 >= 0.95, on 5 hosts.
  assert.deepEqual(offers.map((o) => o.sku).sort(), [
    "415974/59543862", "415974/59543866", "517294/50189137", "528496/59642609",
    "638511/58968817", "670790/59391490", "670790/59391495",
  ]);
  const by = Object.fromEntries(offers.map((o) => [o.sku, o.price]));
  assert.equal(by["415974/59543862"], 2_534_444); // 5.068888888888889 / 2 = 2.5344444...
  assert.equal(by["415974/59543866"], 2_535_556); // 2.5355555555555553 rounds half up
  assert.equal(by["670790/59391490"], 3_197_486); // 6.394971125925926 / 2 = 3.19748556...
  // Hosts: 2202222, (2534444+2535556)/2 = 2535000, 2668889, 3171111, (3197486+3201768)/2 = 3199627.
  assert.equal(providerValue("vast", offers), 2_668_889);
});

test("runpod: secure and community prices of H100 types", () => {
  const offers = runpod.parse(fixture("runpod"));
  assert.equal(offers.length, 6);
  assert.deepEqual(prices(offers), [1_990_000, 2_590_000, 2_690_000, 2_890_000, 3_190_000, 3_990_000]);
  assert.equal(providerValue("runpod", offers), 2_790_000); // (2.69 + 2.89) / 2
});

test("akash: price.med of the h100 model, with availability noted", () => {
  const d = akash.parse(fixture("akash"));
  assert.deepEqual(d.offers, [{ sku: "h100 80Gi SXM5", price: 2_560_000 }]);
  assert.equal(d.note, "h100 80Gi SXM5: availability 20/56 GPUs, providerAvailability 3/3");
});

test("lium: price_per_gpu of H100 executors", () => {
  const offers = lium.parse(fixture("lium"));
  // 9 H100 executors (the fixture also keeps 2 non-H100 ones that must be skipped).
  assert.deepEqual(prices(offers), [2_500_000, 2_500_000, 2_750_000, 2_900_000, 2_900_000, 2_900_000, 2_900_000, 3_200_000, 5_000_000]);
  assert.equal(providerValue("lium", offers), 2_900_000);
});

test("verda: price_per_hour / GPUs of H100 types, not spot", () => {
  const offers = verda.parse(fixture("verda"));
  assert.deepEqual(prices(offers), [5_085_000, 5_087_000, 5_087_000, 5_087_500, 5_087_500]); // 10.17/2, 5.087 x2, 20.35/4, 40.70/8
  assert.equal(providerValue("verda", offers), 5_087_000);
});

test("shadeform: cents per instance / GPUs, one draft per cloud", () => {
  const drafts = shadeform.parse(fixture("shadeform"));
  const values = Object.fromEntries(drafts.map((d) => [d.id, providerValue("shadeform", d.offers)]));
  assert.deepEqual(values, {
    latitude: 1_891_250, // 1.66, 1.7925 (1434/8), 1.99, 2.2425 (897/4): mean of middle two
    hyperstack: 2_500_000,
    voltagepark: 1_990_000,
    denvr: 2_500_000,
    horizon: 1_950_000,
    massedcompute: 2_730_000,
    paperspace: 5_990_000,
    digitalocean: 4_410_000,
    scaleway: 3_300_000,
    lambdalabs: 4_190_000, // 3.99, 4.09, 4.19, 4.29, 4.36
    nebius: 3_923_125, // (30.93/8 = 3.86625 + 3.98) / 2
    excesssupply: 3_000_000,
    imwt: 2_480_000,
    verda: 3_310_000,
  });
  assert.equal(drafts.reduce((n, d) => n + d.offers.length, 0), 39);
});

test("parsers reject a response of the wrong shape", () => {
  assert.throws(() => vast.parse({ nope: [] }), /offers is not a list/);
  assert.throws(() => runpod.parse({ errors: [{ message: "x" }] }), /data is not an object/);
  assert.throws(() => lium.parse({ detail: "rate limited" }), /executors is not a list/);
});
