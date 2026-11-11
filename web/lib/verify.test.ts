import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { checkBundle, checkMedian, hashFromFileName } from "./verify.ts";

const dir = new URL("../../evidence/bundles/", import.meta.url);
const file = readdirSync(dir).find((f) => f.endsWith(".json"));

test("the recorded bundle hashes to the hash in its file name and passes the method's checks", { skip: !file && "no recorded bundle" }, async () => {
  const text = readFileSync(new URL(file!, dir), "utf8");
  const prefix = hashFromFileName(file!)!;
  const rows = await checkBundle(text, null, JSON.parse(text).index, "sample");
  const rules = rows.find((r) => r.kind === "rules")!;
  assert.equal(rules.ok, true, JSON.stringify(rules));
  const idx = rows.find((r) => r.kind === "index")!;
  assert.equal(idx.ok, true);
  const withHash = await checkBundle(text, "0".repeat(64), null, "sample");
  const h = withHash.find((r) => r.kind === "hash");
  assert.ok(h && h.kind === "hash" && h.file.startsWith(prefix));
  assert.equal(h.ok, false);
});

test("each chip's recorded bundle (version 2) hashes to its file name and passes the method's checks", async () => {
  for (const chip of ["h100", "h200", "a100-80"]) {
    const sub = new URL(`${chip}/`, dir);
    const name = readdirSync(sub).find((f) => f.endsWith(".json"));
    assert.ok(name, `${chip} has a recorded bundle`);
    const text = readFileSync(new URL(name!, sub), "utf8");
    assert.equal(JSON.parse(text).chip, chip);
    const rows = await checkBundle(text, "0".repeat(64), JSON.parse(text).index, chip);
    const h = rows.find((r) => r.kind === "hash");
    assert.ok(h && h.kind === "hash" && h.file.startsWith(hashFromFileName(name!)!), chip);
    assert.equal(rows.find((r) => r.kind === "rules")!.ok, true, chip);
  }
});

test("a tampered bundle fails the hash and the index", async () => {
  const text = readFileSync(new URL(file!, dir), "utf8");
  const b = JSON.parse(text);
  b.index = b.index + 10_000;
  const rows = await checkBundle(JSON.stringify(b), "f".repeat(64), b.index - 10_000, "x");
  assert.equal(rows.find((r) => r.kind === "hash")!.ok, false);
  assert.equal(rows.find((r) => r.kind === "rules")!.ok, false);
  assert.equal(rows.find((r) => r.kind === "index")!.ok, false);
});

test("not JSON is a fetch failure, not a crash", async () => {
  const rows = await checkBundle("<html>", "a".repeat(64), 1, "x");
  assert.deepEqual(rows.map((r) => r.kind), ["fetch"]);
});

test("the print is recomputed as the median of its reports", () => {
  assert.equal(checkMedian({ bucket: 1, price: 2, reports: [{ reporter: "a", price: 1, bundle: "" }, { reporter: "b", price: 3, bundle: "" }] }).ok, true);
  assert.equal(checkMedian({ bucket: 1, price: 3, reports: [{ reporter: "a", price: 1, bundle: "" }, { reporter: "b", price: 3, bundle: "" }] }).ok, false);
  assert.equal(checkMedian({ bucket: 1, price: 3, reports: [] }).ok, false);
  assert.equal(hashFromFileName("evidence/bundles/1794423600-1c0e2cb8b9c8.json"), "1c0e2cb8b9c8");
  assert.equal(hashFromFileName("x.json"), null);
});
