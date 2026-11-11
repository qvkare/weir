// The only module that does HTTP. One request per source, a 15-second timeout, one retry.
import { sha256Hex } from "./bundle.ts";
import type { Outcome, Source } from "./method.ts";

export const USER_AGENT = "weir-index/0.1 (H100 on-demand price index; public keyless endpoints)";
const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;

export interface Fetched extends Outcome {
  bytes: Uint8Array | null;
}

async function once(source: Source): Promise<Uint8Array> {
  const res = await fetch(source.url, {
    method: source.method,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(source.body ? { "Content-Type": "application/json" } : {}) },
    ...(source.body ? { body: source.body } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return bytes;
}

/** Fetches one source, retrying once after a short pause. Never throws. */
export async function fetchSource(source: Source): Promise<Fetched> {
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      const bytes = await once(source);
      return { source, bytes, body: new TextDecoder().decode(bytes), raw_sha256: await sha256Hex(bytes) };
    } catch (e) {
      const err = e as Error;
      error = err.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000} s` : err.message;
    }
  }
  return { source, bytes: null, body: null, raw_sha256: await sha256Hex(""), error };
}

/** Fetches every source in parallel (each source is a different host). */
export function fetchAll(sources: readonly Source[]): Promise<Fetched[]> {
  return Promise.all(sources.map(fetchSource));
}
