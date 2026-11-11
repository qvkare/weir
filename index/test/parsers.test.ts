// Each parser for each chip against real responses saved on 2026-11-11 (fixtures/, about
// 19:25 UTC, and fixtures/v2/, about 21:46 UTC). Expected values were worked out by hand from
// the fixture files (see the comments) and are not produced by the code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHIPS, H100_V1 } from "../src/chips.ts";
import { providerValue } from "../src/method.ts";
import * as akash from "../src/sources/akash.ts";
import * as lium from "../src/sources/lium.ts";
import * as runpod from "../src/sources/runpod.ts";
import * as shadeform from "../src/sources/shadeform.ts";
import * as vast from "../src/sources/vast.ts";
import * as verda from "../src/sources/verda.ts";
import { fixture, v2 } from "./fixtures.ts";

const { h100, h200 } = CHIPS;
const a100 = CHIPS["a100-80"];

const prices = (offers: { price: number }[]) => offers.map((o) => o.price).sort((a, b) => a - b);

test("vast: verified, reliability2 >= 0.95, dph_total / num_gpus, one price per host", () => {
  const offers = vast.parse(fixture("vast"), h100);
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
  const offers = runpod.parse(fixture("runpod"), h100);
  assert.equal(offers.length, 6);
  assert.deepEqual(prices(offers), [1_990_000, 2_590_000, 2_690_000, 2_890_000, 3_190_000, 3_990_000]);
  assert.equal(providerValue("runpod", offers), 2_790_000); // (2.69 + 2.89) / 2
});

test("akash: price.med of the h100 model, with availability noted", () => {
  const d = akash.parse(fixture("akash"), h100);
  assert.deepEqual(d.offers, [{ sku: "h100 80Gi SXM5", price: 2_560_000 }]);
  assert.equal(d.note, "h100 80Gi SXM5: availability 20/56 GPUs, providerAvailability 3/3");
});

test("lium: price_per_gpu of H100 executors", () => {
  const offers = lium.parse(fixture("lium"), h100);
  // 9 H100 executors (the fixture also keeps 2 non-H100 ones that must be skipped).
  assert.deepEqual(prices(offers), [2_500_000, 2_500_000, 2_750_000, 2_900_000, 2_900_000, 2_900_000, 2_900_000, 3_200_000, 5_000_000]);
  assert.equal(providerValue("lium", offers), 2_900_000);
});

test("verda: price_per_hour / GPUs of H100 types, not spot", () => {
  const offers = verda.parse(fixture("verda"), h100);
  assert.deepEqual(prices(offers), [5_085_000, 5_087_000, 5_087_000, 5_087_500, 5_087_500]); // 10.17/2, 5.087 x2, 20.35/4, 40.70/8
  assert.equal(providerValue("verda", offers), 5_087_000);
});

test("shadeform: cents per instance / GPUs, one draft per cloud", () => {
  const drafts = shadeform.parse(fixture("shadeform"), h100);
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
  assert.throws(() => vast.parse({ nope: [] }, h100), /offers is not a list/);
  assert.throws(() => runpod.parse({ errors: [{ message: "x" }] }, h100), /data is not an object/);
  assert.throws(() => lium.parse({ detail: "rate limited" }, h100), /executors is not a list/);
});

// ---- Second day (fixtures/v2), every chip. Unfiltered Shadeform and full RunPod, Akash and
// Verda catalogues: one body serves every chip. Vast is one body per chip.

test("version 1 and version 2 H100 rules pick the same offers from the first day's bodies", () => {
  for (const [mod, id] of [[runpod, "runpod"], [lium, "lium"], [verda, "verda"]] as const) {
    assert.deepEqual(mod.parse(fixture(id), h100), mod.parse(fixture(id), H100_V1), id);
  }
  assert.deepEqual(shadeform.parse(fixture("shadeform"), h100), shadeform.parse(fixture("shadeform"), H100_V1));
});

test("vast per chip: H100 has one verified host, H200 eight, A100 80 GB two", () => {
  const h = vast.parse(v2("vast", h100), h100);
  assert.deepEqual(h, [{ sku: "364425/56488186", price: 2_671_111 }]); // dph_total 2.6711111..., 1 GPU
  const offers = vast.parse(v2("vast", h200), h200);
  assert.equal(offers.length, 12);
  // Host medians: 3.3222, 3.6022, 3.7711, 4.0022, 4.0022, 5.0694 (three offers), 6.6860 (two),
  // 7.6906 (two). Eight hosts, so the mean of the 4th and 5th, both 4.002222.
  assert.equal(providerValue("vast", offers), 4_002_222);
  assert.deepEqual(vast.parse(v2("vast", a100), a100).map((o) => o.sku).sort(), ["569416/59858180", "713527/58940649"]);
});

test("vast: the A100 rule needs gpu_ram >= 70000 MB, and the cap is reported", () => {
  const body = v2("vast", a100) as { offers: Record<string, unknown>[] };
  const forty = { ...body.offers[0]!, id: 1, gpu_ram: 40_960 };
  assert.equal(vast.parse({ offers: [...body.offers, forty] }, a100).length, 2);
  assert.equal(vast.parse({ offers: [forty] }, h100).length, 0); // an A100 name is not an H100
  assert.equal(vast.capNote(body), "2 offers returned, under the 64-offer cap");
  const full = { offers: Array.from({ length: 64 }, () => body.offers[0]!) };
  assert.equal(vast.capNote(full), "64 offers returned: the 64-offer cap was hit, so these are a sample");
  const query = JSON.parse(vast.source(a100).body!);
  assert.deepEqual(query, {
    gpu_name: { in: ["A100 SXM4", "A100 PCIE"] }, gpu_ram: { gte: 70000 }, rentable: { eq: true },
    verified: { eq: true }, reliability2: { gte: 0.95 }, type: "on-demand", limit: 64,
  });
});

test("runpod per chip: exact display names, 0.50 kept by the parser (the method drops it)", () => {
  const body = v2("runpod");
  assert.deepEqual(prices(runpod.parse(body, h100)), [1_990_000, 2_590_000, 2_690_000, 2_890_000, 3_190_000, 3_990_000]);
  assert.deepEqual(prices(runpod.parse(body, h200)), [500_000, 3_590_000, 3_790_000, 5_290_000]); // H200 NVL community 0.50
  // A100 PCIe 1.79/1.19 and A100 SXM 1.79/1.39; not "A100 SXM 40GB" (secure 0, community 1).
  assert.deepEqual(prices(runpod.parse(body, a100)), [1_190_000, 1_390_000, 1_790_000, 1_790_000]);
});

test("akash per chip: h100, no h200, a100 only at 80Gi", () => {
  const body = v2("akash");
  assert.deepEqual(akash.parse(body, h100).offers, [{ sku: "h100 80Gi SXM5", price: 2_560_000 }]);
  assert.deepEqual(akash.parse(body, h200), { id: "akash", offers: [] });
  const a = akash.parse(body, a100); // the 40Gi entry at 0.84 is skipped
  assert.deepEqual(a.offers, [{ sku: "a100 80Gi SXM4", price: 1_490_000 }]);
  assert.equal(a.note, "a100 80Gi SXM4: availability 31/200 GPUs, providerAvailability 3/4");
});

test("lium per chip: H100 (incl. one PCIe), H200 (incl. one NVL), no A100", () => {
  const body = v2("lium");
  const h = lium.parse(body, h100); // 8 x "80GB HBM3" and 1 x "PCIe" at 1.90
  assert.deepEqual(prices(h), [1_900_000, 2_500_000, 2_500_000, 2_500_000, 2_900_000, 2_900_000, 2_900_000, 2_900_000, 5_000_000]);
  assert.equal(providerValue("lium", h), 2_900_000);
  const g = lium.parse(body, h200); // 12 x "H200" and 1 x "H200 NVL" at 3.85; 13 offers, the 7th is 4.08
  assert.equal(g.length, 13);
  assert.equal(providerValue("lium", g), 4_080_000);
  assert.deepEqual(lium.parse(body, a100), []);
});

test("verda per chip: H200 and A100 80GB, never A100 40GB", () => {
  const body = fixture("verda");
  // 6.504, 13.01/2, 26.02/4, 52.03/8 = 6.50375: mean of 6.504 and 6.505.
  assert.equal(providerValue("verda", verda.parse(body, h200)), 6_504_500);
  // 2.339, 4.678/2, 9.356/4, 18.71/8 = 2.33875: all four, median 2.339.
  assert.deepEqual(prices(verda.parse(body, a100)), [2_338_750, 2_339_000, 2_339_000, 2_339_000]);
});

test("shadeform per chip from one unfiltered body", () => {
  const body = v2("shadeform");
  const values = (chip: typeof h100 | typeof h200 | typeof a100) =>
    Object.fromEntries(shadeform.parse(body, chip).map((d) => [d.id, providerValue("shadeform", d.offers)]));
  // H100 now includes massedcompute's three H100_nvl rows (25.28/8, 6.32/2, 12.64/4 = 3.16 each):
  // 2.7275, 2.7275, 2.73, 2.73, 3.14, 3.16, 3.16, 3.16, so (2.73 + 3.14) / 2.
  assert.equal(values(h100).massedcompute, 2_935_000);
  assert.equal(Object.keys(values(h100)).length, 14);
  assert.deepEqual(values(h200), {
    excesssupply: 4_516_250, // 4.51625 x3, 4.63 x2, 4.00 x2, 4.25 x1 -> sorted middle 4.51625
    nebius: 4_573_125, // (4.63 + 36.13/8 = 4.51625) / 2
    boostrun: 4_250_000,
    digitalocean: 4_470_000,
    horizon: 3_000_000,
    verda: 4_307_500, // 16.82/4 = 4.205, 9.23/2 = 4.615, 4.41, 33.64/8 = 4.205 -> (4.205 + 4.41) / 2
  });
  assert.deepEqual(values(a100), {
    crusoe: 2_000_000, // 2.30, 2.00 x4
    paperspace: 3_230_000, // 3.22, 3.22, 3.24, 3.28
    hyperstack: 1_350_000, // 1.40, 1.35 x4
    vultr: 2_600_000,
    lambdalabs: 2_790_000, // 22.32/8
    massedcompute: 1_365_000, // 1.38 x4, 1.35 x4
    excesssupply: 1_350_000, // 3.00, 1.35, 1.35
    denvr: 1_512_500, // 1.50, 12.20/8 = 1.525
    verda: 1_856_250, // 1.8575, 1.85, 1.8575, 1.855 -> (1.855 + 1.8575) / 2
  });
});
