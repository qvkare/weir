// `pnpm --filter @weir/backtest run derive`
// Reads data/raw/ and writes the small committed files in data/derived/:
// providers.csv, hyperscalers.csv, index.csv, provenance.json, validation.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DERIVED, HISTORY_END, HISTORY_START, RAW } from "../lib/paths.ts";
import { dayRange } from "../lib/dates.ts";
import { toCsv } from "../lib/csv.ts";
import { fmtUsd } from "../lib/money.ts";
import { HYPERSCALERS, MIN_PROVIDERS, inComposite } from "../lib/providers.ts";
import { composite, providerDays } from "../lib/compose.ts";
import type { ProviderDay } from "../lib/compose.ts";
import { readAkash, readGpuhunt, readHubbard } from "./sources.ts";
import type { Extracted, SourceFile } from "./sources.ts";
import { validate } from "./validate.ts";
import { HUBBARD_README } from "../fetch/hubbard.ts";
import { AKASH_CDX, AKASH_CDX_URL } from "../fetch/akash.ts";
import { HENRY_FILE, HENRY_LICENSE_FILE, HENRY_URL, ORNN_FILE, ORNN_URL } from "../fetch/crosscheck.ts";
import { createHash } from "node:crypto";

const days = dayRange(HISTORY_START, HISTORY_END);

console.log("reading gpuhunt catalogs");
const gpuhunt = await readGpuhunt();
console.log("reading afhubbard parquet snapshots");
const hubbard = await readHubbard();
console.log("reading Akash captures");
const akash = await readAkash();

const all = providerDays([...gpuhunt.obs, ...hubbard.obs, ...akash.obs]).filter(
  (r) => r.day >= HISTORY_START && r.day <= HISTORY_END,
);
const market = all.filter((r) => inComposite(r.provider));
const hyper = all.filter((r) => HYPERSCALERS.has(r.provider));
const index = composite(days, all);

mkdirSync(DERIVED, { recursive: true });
const providerCsv = (rows: ProviderDay[]): string =>
  toCsv(
    ["date", "provider", "price_usd_per_gpu_hour", "offers", "source"],
    rows.map((r) => [r.day, r.provider, fmtUsd(r.price), r.offers, r.source]),
  );
writeFileSync(join(DERIVED, "providers.csv"), providerCsv(market));
writeFileSync(join(DERIVED, "hyperscalers.csv"), providerCsv(hyper));
writeFileSync(
  join(DERIVED, "index.csv"),
  toCsv(
    ["date", "index", "providers"],
    index.map((d) => [d.day, d.index === null ? "" : fmtUsd(d.index), d.providers.join(";")]),
  ),
);

// Provenance: every raw file whose rows reached a derived file, plus the listings
// and cross-check files.
function rangeOf(files: SourceFile[]): [string, string] | null {
  if (!files.length) return null;
  const ds = files.map((f) => f.day).sort();
  return [ds[0]!, ds[ds.length - 1]!];
}
function sourceBlock(name: string, ex: Extracted, licence: string, homepage: string, extra: Record<string, unknown>) {
  const used = new Set(all.map((r) => r.source));
  const tagOf = (file: string): string =>
    file
      .replace(/\.zip$/, "")
      .replace(/^hubbard\/prices\//, "hubbard/")
      .replace(/^akash\/(.*)\.json$/, "akash-wayback/$1");
  const usedFiles = ex.files.filter((f) => used.has(tagOf(f.file)));
  const range = rangeOf(ex.files);
  const covered = new Set(ex.files.map((f) => f.day)).size;
  return {
    name,
    homepage,
    licence,
    date_range: range,
    days_with_a_file: covered,
    days_missing_in_range: range ? dayRange(range[0], range[1]).length - covered : 0,
    files_read: ex.files.length,
    files_contributing_rows: usedFiles.length,
    notes: ex.notes,
    ...extra,
    files: ex.files.map((f) => ({ day: f.day, file: f.file, url: f.url, sha256: f.sha256 })),
  };
}
function fileEntry(path: string, url: string, licence: string) {
  const buf = readFileSync(path);
  return { file: path.slice(RAW.length + 1), url, sha256: createHash("sha256").update(buf).digest("hex"), licence };
}

const indexDays = index.filter((d) => d.index !== null);
const firstIdx = indexDays[0]?.day ?? null;
const lastIdx = indexDays[indexDays.length - 1]?.day ?? null;
const counts = indexDays.map((d) => d.providers.length);
const provenance = {
  window: { start: HISTORY_START, end: HISTORY_END, days: days.length },
  rules: {
    qualifying_offer:
      "gpu is a plain H100 80 GB (H100 NVL excluded); on demand (spot/interruptible excluded); price > 0 and gpu_count > 0; multi-node cluster SKUs excluded; available != false where the source has that field",
    offer_value: "price / gpu_count, rounded to the micro-dollar",
    provider_value: "median of the provider's qualifying offers that day (even count: mean of the two middle values, rounded down to the micro-dollar)",
    source_priority: "per provider and day, gpuhunt catalog first, then afhubbard parquet, then Akash Wayback capture",
    composite: `median of in-composite provider values, with at least ${MIN_PROVIDERS} providers; otherwise no value (never interpolated)`,
    hyperscalers: "aws, azure, gcp, oci are reported in hyperscalers.csv and kept out of the composite",
    sampling: "one file per source per day: the gpuhunt catalog found by probing run numbers for that date, the earliest afhubbard snapshot of the day, the earliest Akash capture of the day",
  },
  coverage: {
    index_first_day: firstIdx,
    index_last_day: lastIdx,
    days_with_index: indexDays.length,
    days_without_index: days.length - indexDays.length,
    days_without_index_between_first_and_last:
      firstIdx && lastIdx ? dayRange(firstIdx, lastIdx).length - indexDays.length : 0,
    providers_per_index_day: {
      min: Math.min(...counts),
      max: Math.max(...counts),
      mean: Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)),
    },
    provider_days: Object.fromEntries(
      [...new Set(all.map((r) => r.provider))]
        .sort()
        .map((p) => {
          const ds = all.filter((r) => r.provider === p).map((r) => r.day);
          return [p, { days: ds.length, first: ds[0], last: ds[ds.length - 1], in_composite: inComposite(p) }];
        }),
    ),
  },
  sources: [
    sourceBlock("gpuhunt", gpuhunt, "Catalogs published by dstack for the gpuhunt library (MPL-2.0); the catalog data carries no separate licence statement", "https://github.com/dstackai/gpuhunt", {
      catalog_url_pattern: "https://dstack-gpu-pricing.s3.eu-west-1.amazonaws.com/{v1|v2}/{YYYYMMDD}-{run}/catalog.zip",
      probe_log: "data/raw/gpuhunt/probes.json",
    }),
    sourceBlock("hubbard", hubbard, "CC BY 4.0 (dataset card, afhubbard/gpu-prices). Attribution: Alex Hubbard, GPU Price Tracker, 2026", "https://huggingface.co/datasets/afhubbard/gpu-prices", {
      readme: fileEntry(HUBBARD_README, "https://huggingface.co/datasets/afhubbard/gpu-prices/raw/main/README.md", "CC BY 4.0"),
    }),
    sourceBlock("akash", akash, "Akash Console API response archived by the Internet Archive; no licence stated by the source", "https://console-api.akash.network/v1/gpu-prices", {
      cdx_listing: fileEntry(AKASH_CDX, AKASH_CDX_URL, "Internet Archive CDX listing"),
    }),
  ],
  crosschecks: [
    { ...fileEntry(HENRY_FILE, HENRY_URL, "MIT (repository LICENSE); unaudited"), use: "validation only" },
    { ...fileEntry(HENRY_LICENSE_FILE, HENRY_URL.replace(/series\/.*$/, "LICENSE"), "MIT"), use: "licence text" },
    {
      ...fileEntry(ORNN_FILE, ORNN_URL, "reuse terms not checked"),
      use: "validation only; the series itself is not redistributed in this repository",
    },
  ],
};
writeFileSync(join(DERIVED, "provenance.json"), JSON.stringify(provenance, null, 1) + "\n");

const validation = validate(index, all, gpuhunt.obs, hubbard.obs);
writeFileSync(join(DERIVED, "validation.json"), JSON.stringify(validation, null, 1) + "\n");

console.log(
  `providers.csv ${market.length} rows, hyperscalers.csv ${hyper.length} rows, index days ${indexDays.length}/${days.length} (${firstIdx}..${lastIdx})`,
);
