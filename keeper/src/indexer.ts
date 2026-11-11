// The index step: at most once per five-minute window, one fetch serves every chip (the
// index package's `fetchChips`, which makes each distinct request once: 8 requests for three
// chips), through the keeper's metered fetch with no retry. Each chip gets its own bundle,
// stored as canonical JSON under its hash. A chip whose sources form no index gets nothing
// stored and its reason kept; a price is never invented, carried forward or interpolated.
import { bundleHash, canonical, CHIP_IDS, CHIPS, makeBundle, sourcesFor, type ChipId } from "@weir/index";
import { fetchChips, requestKey, type FetchFn } from "@weir/index/fetch";
import { KEYS, readJson, type KeeperStore } from "./store.ts";

export const INDEX_EVERY_SECS = 300;

/** The bundle a chip's reports are made from. */
export interface LatestBundle {
  chip: ChipId;
  hash: string;
  bucket: number;
  fetched_at: number;
  index: number;
}

/** The last fetch, whether or not each chip formed an index. */
export interface IndexAttempt {
  at: number;
  chips: Partial<Record<ChipId, { ok: boolean; hash: string | null; index: number | null; reason: string | null }>>;
  sources: { id: string; chip: ChipId; ok: boolean; error?: string }[];
}

/** HTTP requests one fetch of these chips makes. */
export const requestsFor = (chips: readonly ChipId[]): number => new Set(chips.flatMap((c) => sourcesFor(CHIPS[c]).map(requestKey))).size;

/** True when no fetch has been made in the current five-minute window. */
export async function indexDue(store: KeeperStore, now: number): Promise<boolean> {
  const last = await readJson<IndexAttempt>(store, KEYS.indexAttempt);
  return last === null || Math.floor(last.at / INDEX_EVERY_SECS) < Math.floor(now / INDEX_EVERY_SECS);
}

/** Fetches every chip's sources once, builds one bundle per chip, stores those with an index. */
export async function refreshIndex(
  store: KeeperStore,
  fetchFn: FetchFn,
  now: number,
  chips: readonly ChipId[] = CHIP_IDS,
): Promise<{ attempt: IndexAttempt; latest: Partial<Record<ChipId, LatestBundle>> }> {
  const fetched = await fetchChips(chips.map((c) => CHIPS[c]), { fetch: fetchFn, retries: 0 });
  const bucket = Math.floor(now / INDEX_EVERY_SECS) * INDEX_EVERY_SECS;
  const attempt: IndexAttempt = { at: now, chips: {}, sources: [] };
  const latest: Partial<Record<ChipId, LatestBundle>> = {};
  for (const { chip, outcomes } of fetched) {
    const id = chip.id as ChipId;
    for (const o of outcomes) attempt.sources.push({ id: o.source.id, chip: id, ok: o.body !== null, ...(o.error ? { error: o.error } : {}) });
    const bundle = makeBundle(bucket, now, outcomes, chip);
    if (bundle.index === null) {
      attempt.chips[id] = { ok: false, hash: null, index: null, reason: bundle.reason ?? "no index" };
      continue;
    }
    const hash = await bundleHash(bundle);
    await store.put(KEYS.bundle(hash), canonical(bundle));
    latest[id] = { chip: id, hash, bucket, fetched_at: now, index: bundle.index };
    attempt.chips[id] = { ok: true, hash, index: bundle.index, reason: null };
  }
  if (Object.keys(latest).length > 0) await store.put(KEYS.latest, JSON.stringify({ ...(await readLatest(store)), ...latest }));
  await store.put(KEYS.indexAttempt, JSON.stringify(attempt));
  return { attempt, latest };
}

/** The latest bundle per chip (one store key for all chips). */
export async function readLatest(store: KeeperStore): Promise<Partial<Record<ChipId, LatestBundle>>> {
  return (await readJson<Partial<Record<ChipId, LatestBundle>>>(store, KEYS.latest)) ?? {};
}
