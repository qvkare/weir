// The index step: at most once per five-minute window, fetch every source once, build the
// bundle with the index package, and store its canonical JSON under its hash. When no index
// can be formed nothing is stored and the reason is kept; a price is never invented, carried
// forward or interpolated.
import { bundleHash, canonical, makeBundle, sha256Hex, SOURCES, type Outcome, type Source } from "@weir/index";
import { USER_AGENT } from "@weir/index/fetch";
import type { Fetch } from "./ports.ts";
import { KEYS, readJson, type KeeperStore } from "./store.ts";

export const INDEX_EVERY_SECS = 300;
const TIMEOUT_MS = 15_000;

/** The bundle reports are made from. */
export interface LatestBundle {
  hash: string;
  bucket: number;
  fetched_at: number;
  index: number;
}

/** The last fetch, whether or not it formed an index. */
export interface IndexAttempt {
  at: number;
  ok: boolean;
  hash: string | null;
  index: number | null;
  reason: string | null;
  sources: { id: string; ok: boolean; error?: string }[];
}

/** True when no fetch has been made in the current five-minute window. */
export async function indexDue(store: KeeperStore, now: number): Promise<boolean> {
  const last = await readJson<IndexAttempt>(store, KEYS.indexAttempt);
  return last === null || Math.floor(last.at / INDEX_EVERY_SECS) < Math.floor(now / INDEX_EVERY_SECS);
}

/** One request per source, no retry (the budget is small; the next window tries again). */
async function fetchOne(source: Source, fetchFn: Fetch): Promise<Outcome> {
  try {
    const res = await fetchFn(source.url, {
      method: source.method,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(source.body ? { "Content-Type": "application/json" } : {}) },
      ...(source.body ? { body: source.body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { source, body: new TextDecoder().decode(bytes), raw_sha256: await sha256Hex(bytes) };
  } catch (e) {
    const err = e as Error;
    const error = err.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000} s` : err.message;
    return { source, body: null, raw_sha256: await sha256Hex(""), error };
  }
}

/** Fetches every source in parallel, builds the bundle, stores it if it has an index. */
export async function refreshIndex(
  store: KeeperStore,
  fetchFn: Fetch,
  now: number,
  sources: readonly Source[] = SOURCES,
): Promise<{ attempt: IndexAttempt; latest: LatestBundle | null }> {
  const outcomes = await Promise.all(sources.map((s) => fetchOne(s, fetchFn)));
  const bucket = Math.floor(now / INDEX_EVERY_SECS) * INDEX_EVERY_SECS;
  const bundle = makeBundle(bucket, now, outcomes);
  const status = outcomes.map((o) => ({ id: o.source.id, ok: o.body !== null, ...(o.error ? { error: o.error } : {}) }));
  if (bundle.index === null) {
    const attempt: IndexAttempt = { at: now, ok: false, hash: null, index: null, reason: bundle.reason ?? "no index", sources: status };
    await store.put(KEYS.indexAttempt, JSON.stringify(attempt));
    return { attempt, latest: null };
  }
  const hash = await bundleHash(bundle);
  await store.put(KEYS.bundle(hash), canonical(bundle));
  const latest: LatestBundle = { hash, bucket, fetched_at: now, index: bundle.index };
  await store.put(KEYS.latest, JSON.stringify(latest));
  const attempt: IndexAttempt = { at: now, ok: true, hash, index: bundle.index, reason: null, sources: status };
  await store.put(KEYS.indexAttempt, JSON.stringify(attempt));
  return { attempt, latest };
}
