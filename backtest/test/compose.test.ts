import { test } from "node:test";
import assert from "node:assert/strict";
import { composite, providerDays } from "../src/lib/compose.ts";
import type { Observation } from "../src/lib/compose.ts";
import { canonicalProvider } from "../src/lib/providers.ts";
import { parseCsv } from "../src/lib/csv.ts";
import { fmtUsd, parseUsd } from "../src/lib/money.ts";

const obs = (day: string, provider: string, offers: number[], priority = 0, source = "s"): Observation => ({ day, provider, offers, priority, source });

test("provider value is the median of its offers; even counts take the mean of the middle two, rounded down", () => {
  const [odd, even] = providerDays([obs("2025-01-01", "a", [3, 1, 2]), obs("2025-01-01", "b", [1, 2, 4, 9])]);
  assert.equal(odd!.price, 2);
  assert.equal(even!.price, 3); // (2 + 4) / 2
  const [r] = providerDays([obs("2025-01-01", "c", [2_490_000, 3_290_001])]);
  assert.equal(r!.price, 2_890_000); // floor(5_780_001 / 2)
  assert.equal(r!.offers, 2);
});

test("one value per provider per day, from the highest-priority source", () => {
  const rows = providerDays([obs("2025-01-01", "a", [5], 1, "hubbard"), obs("2025-01-01", "a", [7], 0, "gpuhunt")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.price, 7);
  assert.equal(rows[0]!.source, "gpuhunt");
});

test("index is the median across providers and needs at least 4", () => {
  const day = "2025-01-01";
  const rows = providerDays([obs(day, "a", [1_000_000]), obs(day, "b", [2_000_000]), obs(day, "c", [3_000_000]), obs(day, "d", [10_000_000])]);
  const [d] = composite([day], rows);
  assert.equal(d!.index, 2_500_000);
  assert.deepEqual(d!.providers, ["a", "b", "c", "d"]);
  const [three] = composite([day], rows.slice(0, 3));
  assert.equal(three!.index, null);
});

test("hyperscalers never enter the composite", () => {
  const day = "2025-01-01";
  const rows = providerDays([
    obs(day, "a", [2_000_000]),
    obs(day, "b", [2_000_000]),
    obs(day, "c", [2_000_000]),
    obs(day, "aws", [8_000_000]),
    obs(day, "gcp", [11_000_000]),
  ]);
  const [d] = composite([day], rows);
  assert.equal(d!.index, null); // 3 market providers only
});

test("gaps are never interpolated or carried forward", () => {
  const four = (day: string, v: number) => ["a", "b", "c", "d"].map((p) => obs(day, p, [v]));
  const rows = providerDays([...four("2025-01-01", 2_000_000), ...four("2025-01-03", 4_000_000)]);
  const out = composite(["2025-01-01", "2025-01-02", "2025-01-03"], rows);
  assert.deepEqual(out.map((d) => d.index), [2_000_000, null, 4_000_000]);
});

test("DataCrunch and Verda are one provider; Lambda Labs is lambda", () => {
  assert.equal(canonicalProvider("datacrunch"), "verda");
  assert.equal(canonicalProvider("verda"), "verda");
  assert.equal(canonicalProvider("lambdalabs"), "lambda");
});

test("csv and money helpers round-trip", () => {
  assert.deepEqual(parseCsv('a,b\n1,"x,""y"""\n'), [["a", "b"], ["1", 'x,"y"']]);
  assert.equal(fmtUsd(2_490_000), "2.490000");
  assert.equal(parseUsd("2.490000"), 2_490_000);
  assert.equal(fmtUsd(-1), "-0.000001");
});
