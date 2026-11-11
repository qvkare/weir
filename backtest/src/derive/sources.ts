// Read each raw source into qualifying H100 on-demand offers.
//
// A qualifying offer: GPU is a plain H100 80 GB (H100 NVL 94 GB is a different part
// and is excluded), not spot/interruptible, a positive price and GPU count, not a
// multi-node cluster product, and (where the source says so) listed as available.
// Its value is price / gpu_count, rounded to the micro-dollar.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { parquetReadObjects } from "hyparquet";
import { unzip } from "../lib/zip.ts";
import { parseCsvObjects } from "../lib/csv.ts";
import { toMicro } from "../lib/money.ts";
import { canonicalProvider } from "../lib/providers.ts";
import { readJsonIfExists } from "../lib/http.ts";
import { RAW } from "../lib/paths.ts";
import type { Observation } from "../lib/compose.ts";
import type { Probe } from "../fetch/gpuhunt.ts";
import { GPUHUNT_DIR } from "../fetch/gpuhunt.ts";
import { dailyPicks, hubbardTree, localPath } from "../fetch/hubbard.ts";
import { AKASH_CDX, akashDailyCaptures, captureUrl, capturePath } from "../fetch/akash.ts";

export interface SourceFile {
  /** Path relative to data/raw/. */
  file: string;
  url: string;
  sha256: string;
  day: string;
  source: string;
}

export interface Extracted {
  obs: Observation[];
  files: SourceFile[];
  notes: string[];
}

function sha256(buf: Buffer): Promise<string> {
  return import("node:crypto").then((c) => c.createHash("sha256").update(buf).digest("hex"));
}

function addOffers(map: Map<string, number[]>, provider: string, perGpu: number): void {
  const list = map.get(provider) ?? [];
  list.push(perGpu);
  map.set(provider, list);
}

function isTrue(v: string): boolean {
  return v.trim().toLowerCase() === "true";
}

export async function readGpuhunt(): Promise<Extracted> {
  const probes = readJsonIfExists<Record<string, Probe>>(join(GPUHUNT_DIR, "probes.json"), {});
  const out: Extracted = { obs: [], files: [], notes: [] };
  for (const p of Object.values(probes).sort((a, b) => (a.day < b.day ? -1 : 1))) {
    if (!p.version || !p.file || !p.url) continue;
    const buf = readFileSync(join(RAW, p.file));
    out.files.push({ file: p.file, url: p.url, sha256: await sha256(buf), day: p.day, source: "gpuhunt" });
    const entries = unzip(buf);
    const names = [...entries.keys()].filter((n) => n.endsWith(".csv")).sort();
    const offers = new Map<string, number[]>();
    for (const name of names) {
      const id = name.replace(/^.*\//, "").replace(/\.csv$/, "");
      if (id === "datacrunch" && names.some((n) => n.endsWith("verda.csv"))) continue;
      const provider = canonicalProvider(id);
      for (const r of parseCsvObjects(entries.get(name)!.toString("utf8"))) {
        if (r.gpu_name !== "H100" || isTrue(r.spot ?? "")) continue;
        if ((r.flags ?? "").includes("cluster")) continue;
        const count = Number(r.gpu_count);
        const price = Number(r.price);
        if (!(count > 0) || !(price > 0)) continue;
        addOffers(offers, provider, toMicro(price / count));
      }
    }
    for (const [provider, list] of offers) {
      out.obs.push({ day: p.day, provider, offers: list, source: `gpuhunt/${p.base}/${p.version}`, priority: 0 });
    }
  }
  return out;
}

export async function readHubbard(): Promise<Extracted> {
  const out: Extracted = { obs: [], files: [], notes: [] };
  const picks = dailyPicks(hubbardTree());
  for (const [day, f] of [...picks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const buf = readFileSync(localPath(f));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const rows = (await parquetReadObjects({
      file: ab,
      columns: ["provider", "gpu_type", "gpu_count", "gpu_memory_gb", "price_per_hour", "is_spot", "available", "quality"],
      compressors: { ZSTD: (input: Uint8Array) => new Uint8Array(zstdDecompressSync(input)) },
    })) as Array<Record<string, unknown>>;
    out.files.push({
      file: `hubbard/${f.path}`,
      url: `https://huggingface.co/datasets/afhubbard/gpu-prices/resolve/main/${f.path}`,
      sha256: await sha256(buf),
      day,
      source: "hubbard",
    });
    const present = new Set(rows.map((r) => String(r.provider)));
    const offers = new Map<string, number[]>();
    for (const r of rows) {
      if (r.gpu_type !== "H100" || Number(r.gpu_memory_gb) !== 80) continue;
      if (r.is_spot === true || r.quality !== "ok" || r.available === false) continue;
      const id = String(r.provider);
      if (id === "datacrunch" && present.has("verda")) continue;
      const count = Number(r.gpu_count);
      const price = Number(r.price_per_hour);
      if (!(count > 0) || !(price > 0)) continue;
      // price_per_hour is float32 in the parquet; rounding to the cent-hundredth
      // first removes float32 noise (2.49 is stored as 2.4900000095).
      addOffers(offers, canonicalProvider(id), toMicro(Math.round((price / count) * 1e5) / 1e5));
    }
    for (const [provider, list] of offers) {
      out.obs.push({ day, provider, offers: list, source: `hubbard/${f.path.replace(/^prices\//, "")}`, priority: 1 });
    }
  }
  return out;
}

interface AkashModel {
  model?: string;
  ram?: string;
  price?: { med?: number } | null;
  availability?: { total?: number };
}

export async function readAkash(): Promise<Extracted> {
  const out: Extracted = { obs: [], files: [], notes: [] };
  const cdx = readJsonIfExists<string[][]>(AKASH_CDX, []);
  for (const [day, ts] of [...akashDailyCaptures(cdx).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let buf: Buffer;
    try {
      buf = readFileSync(capturePath(ts));
    } catch {
      out.notes.push(`akash ${day}: capture ${ts} not downloaded`);
      continue;
    }
    let doc: { models?: AkashModel[] };
    try {
      doc = JSON.parse(buf.toString("utf8")) as { models?: AkashModel[] };
    } catch {
      out.notes.push(`akash ${day}: capture ${ts} is not JSON`);
      continue;
    }
    out.files.push({ file: `akash/${ts}.json`, url: captureUrl(ts), sha256: await sha256(buf), day, source: "akash" });
    // The endpoint reports a median bid price per GPU model rather than single offers;
    // each H100 80 GB model entry counts as one offer at its median.
    const meds: number[] = [];
    for (const m of doc.models ?? []) {
      if (m.model !== "h100" || m.ram !== "80Gi") continue;
      const med = m.price?.med;
      if (typeof med === "number" && med > 0) meds.push(toMicro(med));
    }
    if (meds.length) out.obs.push({ day, provider: "akash", offers: meds, source: `akash-wayback/${ts}`, priority: 2 });
  }
  return out;
}
