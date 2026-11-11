import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const RAW = join(ROOT, "data", "raw");
export const DERIVED = join(ROOT, "data", "derived");
export const RESULTS = join(ROOT, "results");

/** First and last calendar day (UTC) the history aims to cover. */
export const HISTORY_START = "2024-11-01";
export const HISTORY_END = "2026-11-10";
