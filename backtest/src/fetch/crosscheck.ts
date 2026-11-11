// The two cross-check series. Neither feeds the index; both are compared with it.
// - henryzhangpku/gpu-price-index (MIT): weekly H100 rate cards rebuilt from Wayback.
// - Ornn OCPI-H100 (reuse terms unchecked): used locally for comparison only; its
//   values are never written to data/derived/.

import { join } from "node:path";
import { cachedGet } from "../lib/http.ts";
import { RAW } from "../lib/paths.ts";

export const HENRY_URL =
  "https://raw.githubusercontent.com/henryzhangpku/gpu-price-index/HEAD/series/backfill_ratecards_weekly.csv";
export const HENRY_LICENSE_URL = "https://raw.githubusercontent.com/henryzhangpku/gpu-price-index/HEAD/LICENSE";
export const ORNN_URL = "https://data.ornn.com/api/public-index/gpu/H100%20SXM/index-history";

export const HENRY_FILE = join(RAW, "crosscheck", "henry_backfill_ratecards_weekly.csv");
export const HENRY_LICENSE_FILE = join(RAW, "crosscheck", "henry_LICENSE");
export const ORNN_FILE = join(RAW, "crosscheck", "ornn_h100_sxm_index_history.json");

export async function fetchCrosschecks(): Promise<void> {
  for (const [url, file] of [
    [HENRY_URL, HENRY_FILE],
    [HENRY_LICENSE_URL, HENRY_LICENSE_FILE],
    [ORNN_URL, ORNN_FILE],
  ] as const) {
    const body = await cachedGet(url, file);
    console.log(`${url}: ${body ? `${body.length} bytes` : "not found"}`);
  }
}
