// Akash Network's public GPU price endpoint, as archived by the Wayback Machine. The
// CDX listing is saved once; then the earliest 200-status capture of each day is
// downloaded in its raw (`id_`) form, one request at a time with a pause.

import { join } from "node:path";
import { cachedGet } from "../lib/http.ts";
import { RAW } from "../lib/paths.ts";

export const AKASH_ORIGINAL = "https://console-api.akash.network/v1/gpu-prices";
export const AKASH_CDX_URL =
  "https://web.archive.org/cdx/search/cdx?url=console-api.akash.network/v1/gpu-prices&output=json&fl=timestamp,statuscode,digest&filter=statuscode:200";
export const AKASH_DIR = join(RAW, "akash");
export const AKASH_CDX = join(AKASH_DIR, "cdx.json");

export function captureUrl(ts: string): string {
  return `https://web.archive.org/web/${ts}id_/${AKASH_ORIGINAL}`;
}

export function capturePath(ts: string): string {
  return join(AKASH_DIR, `${ts}.json`);
}

/** Earliest capture timestamp per day from a CDX JSON listing. */
export function akashDailyCaptures(cdx: string[][]): Map<string, string> {
  const picks = new Map<string, string>();
  for (const row of cdx.slice(1)) {
    const ts = row[0]!;
    if (row[1] !== "200") continue;
    const day = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    const prev = picks.get(day);
    if (!prev || ts < prev) picks.set(day, ts);
  }
  return picks;
}

export async function fetchAkash(): Promise<void> {
  const body = await cachedGet(AKASH_CDX_URL, AKASH_CDX);
  if (!body) throw new Error("Akash CDX listing not available");
  const picks = akashDailyCaptures(JSON.parse(body.toString("utf8")) as string[][]);
  console.log(`akash: ${picks.size} days with a capture`);
  for (const ts of [...picks.values()].sort()) {
    const got = await cachedGet(captureUrl(ts), capturePath(ts));
    if (!got) console.log(`akash ${ts}: not retrievable`);
  }
}
