import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleHash, canonical, sha256Hex, verifyBundle, verifyRaw } from "../src/bundle.ts";
import { makeBundle, type Bundle } from "../src/method.ts";
import { fixtureOutcomes, fixtureText } from "./fixtures.ts";

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
