import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { bundleHash, canonical, sha256Hex, verifyBundle, verifyRaw } from "../src/bundle.ts";
import { CHIPS } from "../src/chips.ts";
import { makeBundle, type Bundle } from "../src/method.ts";
import { fixtureOutcomes, fixtureText, v2Outcomes, v2Text } from "./fixtures.ts";

const BUCKET = 1_794_423_600;
const fresh = async (): Promise<Bundle> => makeBundle(BUCKET, 1_794_425_132, await fixtureOutcomes());
const failures = (b: Bundle) => verifyBundle(b).filter((c) => !c.ok).map((c) => c.name);

test("canonical: sorted keys, no whitespace, undefined fields dropped", () => {
  assert.equal(canonical({ b: 1, a: [true, null, "x"], c: undefined, d: { z: 0, y: -2 } }), '{"a":[true,null,"x"],"b":1,"d":{"y":-2,"z":0}}');
  assert.throws(() => canonical({ a: Number.NaN }));
});

test("sha256Hex matches a known vector", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("hash ignores key order and whitespace of the input", async () => {
  const b = await fresh();
  const shuffled = Object.fromEntries(Object.entries(b).reverse()) as unknown as Bundle; // top-level keys reversed
  const pretty = JSON.parse(JSON.stringify(b, null, 2)) as Bundle;
  const reordered = { ...b, providers: b.providers.map((p) => Object.fromEntries(Object.entries(p).reverse())) } as Bundle;
  const h = await bundleHash(b);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(await bundleHash(shuffled), h);
  assert.equal(await bundleHash(pretty), h);
  assert.equal(await bundleHash(reordered), h);
  assert.equal(await bundleHash(await fresh()), h); // same input, same hash
});

test("an untouched bundle passes every check", async () => {
  assert.deepEqual(failures(await fresh()), []);
});

test("verifyBundle catches a tampered offer", async () => {
  const b = await fresh();
  const lium = b.providers.find((p) => p.id === "lium")!;
  for (const o of lium.offers) if (o.price === 2_900_000) o.price = 4_000_000; // shifts lium's median
  assert.deepEqual(failures(b), ["lium: value"]);
});

test("verifyBundle catches a tampered provider value", async () => {
  const b = await fresh();
  b.providers.find((p) => p.id === "runpod")!.value = 2_800_000;
  assert.ok(failures(b).includes("runpod: value"));
});

test("verifyBundle catches a tampered index, and a valid provider excluded by hand", async () => {
  const b = await fresh();
  b.index = 2_770_000;
  assert.deepEqual(failures(b), ["index"]);
  const c = await fresh();
  const p = c.providers.find((x) => x.id === "paperspace")!;
  p.status = "excluded";
  p.reason = "looked high";
  delete p.value;
  assert.deepEqual(failures(c), ["paperspace: excluded with a reason that holds", "index"]);
});

test("verifyRaw re-derives a source's providers from its raw body", async () => {
  const b = await fresh();
  const body = new TextEncoder().encode(fixtureText("shadeform"));
  assert.ok((await verifyRaw(b, "shadeform", body)).every((c) => c.ok));
  b.providers.find((p) => p.id === "nebius")!.offers.pop();
  assert.deepEqual((await verifyRaw(b, "shadeform", body)).filter((c) => !c.ok).map((c) => c.name), ["raw shadeform: providers re-parsed"]);
  const other = new TextEncoder().encode(fixtureText("shadeform") + " ");
  assert.equal((await verifyRaw(b, "shadeform", other))[0]!.ok, false);
});

// ---- Both method versions.

const V1_FILE = new URL("../../evidence/bundles/1794423600-1c0e2cb8b9c8.json", import.meta.url);
const v1Text = () => readFileSync(V1_FILE, "utf8");
const enc = (t: string) => new TextEncoder().encode(t);

test("the recorded version-1 bundle still verifies under version 1, raw bodies included", async () => {
  const text = v1Text();
  const b = JSON.parse(text) as Bundle;
  assert.equal(b.method, "weir-h100-od/1");
  assert.equal(canonical(b), text);
  assert.equal((await bundleHash(b)).slice(0, 12), "1c0e2cb8b9c8");
  assert.deepEqual(failures(b), []);
  for (const id of ["vast", "runpod", "akash", "lium", "verda", "shadeform"]) {
    const body = readFileSync(new URL(`../../evidence/bundles/1794423600-1c0e2cb8b9c8.raw/${id}.json`, import.meta.url));
    assert.deepEqual((await verifyRaw(b, id, body)).filter((c) => !c.ok).map((c) => c.name), [], id);
  }
});

test("verifyBundle dispatches on method: version-1 checks, unknown method", async () => {
  const b = JSON.parse(v1Text()) as Bundle;
  // Relabelled as version 2 it is internally consistent (nothing was below 25%, no fallback),
  // but it is a different document with a different hash, so it cannot pass for the posted one.
  const relabelled = { ...b, method: "weir-gpu-od/2", chip: "h100", index_name: "H100-OD" };
  assert.deepEqual(failures(relabelled), []);
  assert.notEqual(await bundleHash(relabelled), await bundleHash(b));
  const withDrop = JSON.parse(v1Text()) as Bundle;
  withDrop.providers[0]!.dropped = [{ sku: "x", price: 0, reason: "placeholder" }];
  assert.ok(failures(withDrop).includes("akash: version 1 drops nothing"));
  assert.ok(failures({ ...b, chip: "h100" }).includes("version 1 has no chip or index_name"));
  assert.deepEqual(failures({ ...b, method: "weir-h100-od/9" }), ["method"]);
});

for (const chip of Object.values(CHIPS)) {
  test(`version-2 ${chip.id} bundle verifies, and every raw body re-parses to it`, async () => {
    const b = makeBundle(1_794_430_800, 1_794_433_000, await v2Outcomes(chip), chip);
    assert.deepEqual(failures(b), []);
    for (const id of ["vast", "runpod", "akash", "lium", "verda", "shadeform"]) {
      assert.deepEqual((await verifyRaw(b, id, enc(v2Text(id, chip)))).filter((c) => !c.ok).map((c) => c.name), [], id);
    }
  });
}

test("a tampered chip field fails verification", async () => {
  const b = makeBundle(0, 0, await v2Outcomes(CHIPS.h100), CHIPS.h100);
  assert.deepEqual(failures({ ...b, chip: "h200" }), ["index_name matches chip"]);
  assert.deepEqual(failures({ ...b, chip: "b200" }), ["chip is supported"]);
  // Changing chip and index_name together keeps the bundle self-consistent, so it takes the
  // raw bodies (or the hash posted on chain) to catch it: re-parsed as H200, nothing matches.
  const both = { ...b, chip: "h200", index_name: "H200-OD" };
  assert.notEqual(await bundleHash(both), await bundleHash(b));
  const raw = await verifyRaw(both, "runpod", enc(v2Text("runpod")));
  assert.deepEqual(raw.filter((c) => !c.ok).map((c) => c.name), ["raw runpod: providers re-parsed"]);
});

test("a placeholder moved back into the offers, or a dropped real offer, fails", async () => {
  const b = makeBundle(0, 0, await v2Outcomes(CHIPS.h200), CHIPS.h200);
  const rp = b.providers.find((p) => p.id === "runpod")!;
  const back = structuredClone(b);
  const r = back.providers.find((p) => p.id === "runpod")!;
  r.offers = [...rp.offers, { sku: rp.dropped![0]!.sku, price: rp.dropped![0]!.price }].sort((x, y) => (x.sku < y.sku ? -1 : 1));
  delete r.dropped;
  assert.deepEqual(failures(back), ["runpod: placeholders"]);
  const hide = structuredClone(b);
  const h = hide.providers.find((p) => p.id === "runpod")!;
  h.dropped = [...h.dropped!, { ...h.offers[2]!, reason: h.dropped![0]!.reason }].sort((x, y) => (x.sku < y.sku ? -1 : 1));
  h.offers = h.offers.slice(0, 2);
  h.value = 3_690_000; // (3.59 + 3.79) / 2; the index (4.25) does not move
  assert.deepEqual(failures(hide), ["runpod: placeholders", "runpod: value"]);
});

test("the Verda fallback verifies, and cannot be claimed while Verda's fetch worked", async () => {
  const fell = makeBundle(0, 0, await v2Outcomes(CHIPS.h100, ["verda"]), CHIPS.h100);
  assert.deepEqual(failures(fell), []);
  const b = makeBundle(0, 0, await v2Outcomes(CHIPS.h100), CHIPS.h100);
  const sv = b.providers.find((p) => p.id === "shadeform:verda")!;
  sv.status = "included";
  sv.value = 3_310_000;
  delete sv.reason;
  assert.deepEqual(failures(b), ["shadeform:verda: value", "index"]);
  // Faking the failure needs the empty-body hash and no offers: then it is consistent, and only
  // the raw body (or the on-chain hash) shows that Verda in fact answered.
  const v = fell.providers.find((p) => p.id === "verda")!;
  assert.deepEqual([v.offers, v.raw_sha256], [[], await sha256Hex("")]);
  v.raw_sha256 = "0".repeat(64);
  assert.deepEqual(failures(fell), ["verda: failed fetch hashes the empty body"]);
});
